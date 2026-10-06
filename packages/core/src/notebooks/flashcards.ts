import {
  type Card,
  type FlashcardGen,
  FlashcardGenSchema,
  type Rating,
  type ReviewQueue,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { UNTRUSTED_RULE } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";
import { NEW_CARD, review } from "./sm2.ts";
import {
  asRefs,
  CHUNK_SELECT,
  citationForChunk,
  citeRef,
  notebookScope,
  refsPrompt,
  type StudyDeps,
} from "./sources.ts";

/** Flashcards (notebooks.md "Flashcards (SM-2)"): generated from notebook chunks, each one cited. */

const BATCH = 6;
export const DEFAULT_NEW_PER_DAY = 20;

export const FLASHCARD_SYSTEM = [
  "You write study flashcards from course material.",
  "For each source block, write 1 to 3 cards about its most important facts, definitions or ideas.",
  "- front: a clear question. back: the answer in 1 or 2 sentences.",
  "- quote: copy the exact words from the block that support the answer (3 to 40 words).",
  '- chunkRef: the id of that block, e.g. "c2". topic: a short noun phrase (2 to 4 words).',
  "Skip blocks with nothing worth learning (titles, admin notes). Never invent facts.",
  "",
  UNTRUSTED_RULE,
].join("\n");

interface CardRow {
  id: string;
  notebook_id: string;
  front: string;
  back: string;
  topic: string | null;
  source_chunk_id: string | null;
  quote: string | null;
  ef: number;
  interval_days: number;
  repetitions: number;
  due_at: number | null;
  suspended: number;
  introduced_at: number | null;
}

const toCard = (db: Db, r: CardRow): Card => ({
  id: r.id,
  notebookId: r.notebook_id,
  front: r.front,
  back: r.back,
  topic: r.topic,
  sourceChunkId: r.source_chunk_id,
  ef: r.ef,
  intervalDays: r.interval_days,
  repetitions: r.repetitions,
  dueAt: r.due_at,
  suspended: r.suspended === 1,
  isNew: r.introduced_at === null,
  citation: r.source_chunk_id ? citationForChunk(db, r.source_chunk_id, r.quote ?? r.back) : null,
});

/**
 * Generates cards for notebook chunks that have none yet. A card whose quote isn't in its chunk is
 * dropped: the back must be supported by the source.
 */
export async function generateCards(
  deps: StudyDeps,
  notebookId: string,
  opts: {
    maxChunks?: number;
    onProgress?: (done: number, total: number) => void;
    now?: number;
  } = {},
): Promise<{ created: number; dropped: number }> {
  const { db } = deps;
  const rows = db
    .prepare(
      `${CHUNK_SELECT}
       join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where not exists (select 1 from cards k where k.source_chunk_id = c.id and k.notebook_id = ?)
         and c.token_count >= 25
       order by coalesce(d.created_at, d.ingested_at), c.ord limit ?`,
    )
    .all(notebookId, notebookId, opts.maxChunks ?? 48) as {
    id: string;
    documentId: string;
    title: string;
    text: string;
    anchor: string;
  }[];
  let created = 0;
  let dropped = 0;
  const scope = notebookScope(db, notebookId);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = asRefs(rows.slice(i, i + BATCH));
    opts.onProgress?.(i, rows.length);
    const r = await deps.router.run<FlashcardGen>({
      task: "flashcard_gen",
      origin: "user_turn",
      system: FLASHCARD_SYSTEM,
      prompt: `Write flashcards for these blocks:\n\n${refsPrompt(batch)}`,
      schema: FlashcardGenSchema,
      scope,
      hints: { temperature: 0 },
    });
    const now = opts.now ?? Date.now();
    const ins = db.prepare(
      `insert into cards (id, notebook_id, front, back, source_chunk_id, quote, topic, ef, interval_days, repetitions,
       due_at, suspended, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, null, 0, ?)`,
    );
    db.transaction(() => {
      for (const c of r.output.cards) {
        const cite = citeRef(batch, c.chunkRef, c.quote);
        if (!cite) {
          dropped++;
          continue;
        }
        ins.run(
          ulid(now),
          notebookId,
          c.front.trim(),
          c.back.trim(),
          cite.chunkId,
          cite.quote,
          c.topic.trim().toLowerCase() || null,
          NEW_CARD.ef,
          now,
        );
        created++;
      }
    })();
  }
  opts.onProgress?.(rows.length, rows.length);
  return { created, dropped };
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Due cards first, then new cards up to today's limit (introductions count, not creations). */
export function reviewQueue(
  db: Db,
  opts: { notebookId?: string | undefined; now?: number; newPerDay?: number; limit?: number } = {},
): ReviewQueue {
  const now = opts.now ?? Date.now();
  const newLimit = opts.newPerDay ?? DEFAULT_NEW_PER_DAY;
  const nb = opts.notebookId ? "and notebook_id = ?" : "";
  const args = opts.notebookId ? [opts.notebookId] : [];
  const due = db
    .prepare(
      `select * from cards where suspended = 0 and introduced_at is not null and due_at <= ? ${nb} order by due_at limit ?`,
    )
    .all(now, ...args, opts.limit ?? 200) as CardRow[];
  const introducedToday = (
    db
      .prepare(`select count(*) as n from cards where introduced_at >= ? ${nb}`)
      .get(startOfDay(now), ...args) as { n: number }
  ).n;
  const newCards = db
    .prepare(
      `select * from cards where suspended = 0 and introduced_at is null ${nb} order by created_at limit ?`,
    )
    .all(...args, Math.max(0, newLimit - introducedToday)) as CardRow[];
  return {
    cards: [...due, ...newCards].map((r) => toCard(db, r)),
    dueToday: due.length,
    newToday: introducedToday,
    newLimit,
  };
}

export function reviewCard(db: Db, cardId: string, rating: Rating, now = Date.now()): Card {
  const r = db.prepare("select * from cards where id = ?").get(cardId) as CardRow | undefined;
  if (!r) throw Object.assign(new Error("Card not found"), { code: "NOT_FOUND" });
  const next = review(
    { ef: r.ef, intervalDays: r.interval_days, repetitions: r.repetitions },
    rating,
    now,
  );
  db.transaction(() => {
    db.prepare(
      "update cards set ef = ?, interval_days = ?, repetitions = ?, due_at = ?, introduced_at = coalesce(introduced_at, ?) where id = ?",
    ).run(next.ef, next.intervalDays, next.repetitions, next.dueAt, now, cardId);
    db.prepare(
      "insert into card_reviews (id, card_id, reviewed_at, rating, prev_interval, new_interval, prev_ef, new_ef) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      ulid(now),
      cardId,
      now,
      { again: 1, hard: 3, good: 4, easy: 5 }[rating],
      r.interval_days,
      next.intervalDays,
      r.ef,
      next.ef,
    );
  })();
  return toCard(db, db.prepare("select * from cards where id = ?").get(cardId) as CardRow);
}

export function updateCard(
  db: Db,
  cardId: string,
  patch: { front?: string; back?: string; suspended?: boolean },
): Card {
  const r = db.prepare("select * from cards where id = ?").get(cardId) as CardRow | undefined;
  if (!r) throw Object.assign(new Error("Card not found"), { code: "NOT_FOUND" });
  db.prepare("update cards set front = ?, back = ?, suspended = ? where id = ?").run(
    patch.front?.trim() || r.front,
    patch.back?.trim() || r.back,
    patch.suspended === undefined ? r.suspended : patch.suspended ? 1 : 0,
    cardId,
  );
  return toCard(db, db.prepare("select * from cards where id = ?").get(cardId) as CardRow);
}

export function deleteCard(db: Db, cardId: string): boolean {
  return db.prepare("delete from cards where id = ?").run(cardId).changes > 0;
}

export function listCards(db: Db, notebookId: string): Card[] {
  return (
    db
      .prepare("select * from cards where notebook_id = ? order by created_at")
      .all(notebookId) as CardRow[]
  ).map((r) => toCard(db, r));
}

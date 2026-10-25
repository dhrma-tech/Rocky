import type { Commitment, Notification } from "@rocky/contracts";
import { ulid } from "ulid";
import { listCommitments } from "../capture/queries.ts";
import { USER_ENTITY_KEY } from "../entities/entities.ts";
import { addNotification } from "../notifications/notifier.ts";
import type { Db } from "../store/db.ts";

/**
 * Heads-ups (roadmap A7, D-067): once a day Rocky picks the few open commitments worth a nudge
 * ("Due Friday: send Sam the budget") and files them as notifications, which the channels then
 * carry like any other. Scoring is pure and sees only commitments and past heads-ups, so the job
 * has read-only inputs by construction: it can't propose, draft or run anything, and calls no
 * model. Dismissing a heads-up lowers the score of that commitment and of similar ones.
 */

const DAY = 86_400_000;

/** Scores below this are never sent. */
export const HEADS_UP_THRESHOLD = 0.5;
/** No second nudge about the same commitment within this long. */
const REPEAT_GAP = 3 * DAY;
/** Dismissals older than this no longer count. */
const DISMISS_MEMORY = 60 * DAY;
/** The daily run waits for this local hour, so nothing arrives overnight. */
export const HEADS_UP_HOUR = 8;

export interface PastHeadsUp {
  commitmentId: string;
  at: number;
  dismissedAt: number | null;
  /** Of the commitment at the time, for "similar" (null once the commitment is gone). */
  text: string | null;
  counterpartyName: string | null;
  documentId: string | null;
}

export interface HeadsUpPick {
  commitment: Commitment;
  score: number;
  sentence: string;
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/** Jaccard overlap of the words of two commitments (words of three letters or more). */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

function similar(c: Commitment, p: PastHeadsUp): boolean {
  if (p.counterpartyName && c.counterpartyName && p.counterpartyName === c.counterpartyName)
    return true;
  if (p.documentId && p.documentId === c.documentId) return true;
  return p.text !== null && overlap(p.text, c.text) >= 0.5;
}

/** How pressing the date is: 1 when due now, 0.4 a week out, fading after two weeks overdue. */
function proximity(c: Commitment, now: number): number {
  if (c.deadline === null) return 0;
  const days = (c.deadline - now) / DAY;
  if (days < 0) return 1 - Math.min(0.5, -days / 28);
  if (days <= 7) return 1 - (days / 7) * 0.6;
  return 0;
}

/** An undated commitment left open grows to 0.6 over three weeks. */
function staleness(c: Commitment, now: number): number {
  if (c.deadline !== null) return 0;
  return Math.min(1, Math.max(0, (now - c.createdAt) / (21 * DAY))) * 0.6;
}

/** Score 0–1. Dismissed: this one ×0.3, each similar one ×0.75. */
export function scoreCommitment(c: Commitment, past: readonly PastHeadsUp[], now: number): number {
  const base = Math.max(proximity(c, now), staleness(c, now));
  let score = base * (0.5 + 0.5 * (c.confidence ?? 1));
  for (const p of past) {
    if (p.dismissedAt === null || now - p.dismissedAt > DISMISS_MEMORY) continue;
    if (p.commitmentId === c.id) score *= 0.3;
    else if (similar(c, p)) score *= 0.75;
  }
  return Math.round(score * 1000) / 1000;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function dayWord(deadline: number, now: number): string {
  const startOf = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((startOf(deadline) - startOf(now)) / DAY);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return new Date(deadline).toLocaleDateString("en-US", { weekday: "long" });
  return new Date(deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One plain sentence, from fields only: nothing here is generated. */
export function headsUpSentence(c: Commitment, now: number): string {
  const what = clip(c.text.trim().replace(/\s+/g, " "), 140);
  const to = c.counterpartyName ? ` (for ${c.counterpartyName})` : "";
  if (c.deadline === null) {
    const days = Math.floor((now - c.createdAt) / DAY);
    return `Still open after ${days} days: ${what}${to}`;
  }
  if (c.deadline < now) return `Overdue since ${dayWord(c.deadline, now)}: ${what}${to}`;
  return `Due ${dayWord(c.deadline, now)}: ${what}${to}`;
}

/**
 * Which commitments get a heads-up now: open ones over the threshold, not nudged in the last
 * three days, highest first, at most `room`.
 */
export function pickHeadsUps(
  commitments: readonly Commitment[],
  past: readonly PastHeadsUp[],
  now: number,
  room: number,
): HeadsUpPick[] {
  if (room <= 0) return [];
  const recent = new Set(past.filter((p) => now - p.at < REPEAT_GAP).map((p) => p.commitmentId));
  return commitments
    .filter((c) => c.status === "open" && !recent.has(c.id))
    .map((c) => ({ commitment: c, score: scoreCommitment(c, past, now) }))
    .filter((p) => p.score >= HEADS_UP_THRESHOLD)
    .sort(
      (a, b) => b.score - a.score || (a.commitment.deadline ?? 0) - (b.commitment.deadline ?? 0),
    )
    .slice(0, room)
    .map((p) => ({ ...p, sentence: headsUpSentence(p.commitment, now) }));
}

// --- store ---

/** The user's open commitments, and those with no owner yet: "you owe", not "they owe". */
function candidates(db: Db): Commitment[] {
  // Read, not userEntityId(): that creates the entity, and this job only reads.
  const row = db.prepare("select value from settings where key = ?").get(USER_ENTITY_KEY) as
    | { value: string }
    | undefined;
  const me = row ? (JSON.parse(row.value) as string) : null;
  return listCommitments(db, { status: "open", limit: 1000 }).filter(
    (c) => c.ownerEntityId === null || c.ownerEntityId === me,
  );
}

function pastHeadsUps(db: Db, since: number): PastHeadsUp[] {
  return (
    db
      .prepare(
        `select h.commitment_id, h.at, h.dismissed_at, c.text, c.source_document_id,
                e.display_name as counterparty
         from heads_ups h
         left join commitments c on c.id = h.commitment_id
         left join entities e on e.id = c.counterparty_entity_id
         where h.at >= ? or h.dismissed_at >= ?`,
      )
      .all(since, since) as {
      commitment_id: string;
      at: number;
      dismissed_at: number | null;
      text: string | null;
      source_document_id: string | null;
      counterparty: string | null;
    }[]
  ).map((r) => ({
    commitmentId: r.commitment_id,
    at: r.at,
    dismissedAt: r.dismissed_at,
    text: r.text,
    counterpartyName: r.counterparty,
    documentId: r.source_document_id,
  }));
}

const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const LAST_DAY_KEY = "heads_up_last_day";

/**
 * The daily run. Does nothing before HEADS_UP_HOUR, or when it already ran today (the day is kept
 * in settings, so a restart doesn't run it twice). Returns the notifications it filed.
 */
export function runHeadsUps(
  db: Db,
  opts: { perDay: number; now?: number; force?: boolean },
): Notification[] {
  const now = opts.now ?? Date.now();
  const today = localDay(now);
  if (!opts.force) {
    if (new Date(now).getHours() < HEADS_UP_HOUR) return [];
    const last = db.prepare("select value from settings where key = ?").get(LAST_DAY_KEY) as
      | { value: string }
      | undefined;
    if (last && JSON.parse(last.value) === today) return [];
  }
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const sentToday = (
    db.prepare("select count(*) as n from heads_ups where at >= ?").get(startOfDay) as { n: number }
  ).n;
  const picks = pickHeadsUps(
    candidates(db),
    pastHeadsUps(db, now - DISMISS_MEMORY),
    now,
    opts.perDay - sentToday,
  );
  const out: Notification[] = [];
  db.transaction(() => {
    for (const p of picks) {
      const n = addNotification(
        db,
        {
          kind: "heads_up",
          sentence: p.sentence,
          link: "/commitments",
          actionLabel: "Open",
          runId: null,
        },
        now,
      );
      if (!n) continue;
      db.prepare(
        "insert into heads_ups (id, commitment_id, notification_id, at, score) values (?, ?, ?, ?, ?)",
      ).run(ulid(now), p.commitment.id, n.id, now, p.score);
      out.push(n);
    }
    db.prepare("insert or replace into settings (key, value) values (?, ?)").run(
      LAST_DAY_KEY,
      JSON.stringify(today),
    );
  })();
  return out;
}

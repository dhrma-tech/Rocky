import type { Countdown, WorkloadItem } from "@rocky/contracts";
import { searchVec } from "../retrieval/vec.ts";
import type { Embedder } from "../router/embed.ts";
import type { Db } from "../store/db.ts";
import { examDates, getRow } from "./service.ts";

/** Topic weakness, exam countdown and the deadline/workload view (notebooks.md). */

const DAY = 86_400_000;
const PRIOR = 0.5;
const HALF_LIFE_DAYS = 7;

/** weakness = Σ (1 - grade)·w / Σ w with w = 0.5^(age_days / 7); untested topics get 0.5. */
export function weaknessOf(attempts: { grade: number; at: number }[], now: number): number {
  if (!attempts.length) return PRIOR;
  let num = 0;
  let den = 0;
  for (const a of attempts) {
    const w = 0.5 ** ((now - a.at) / DAY / HALF_LIFE_DAYS);
    num += (1 - a.grade) * w;
    den += w;
  }
  return den ? num / den : PRIOR;
}

export function topicWeakness(db: Db, notebookId: string, now = Date.now()) {
  const topics = new Map<
    string,
    { attempts: { grade: number; at: number }[]; cards: number; docs: number }
  >();
  const get = (t: string) => {
    const k = t.trim().toLowerCase();
    let v = topics.get(k);
    if (!v) {
      v = { attempts: [], cards: 0, docs: 0 };
      topics.set(k, v);
    }
    return v;
  };
  for (const r of db
    .prepare(
      "select topic, count(*) n from cards where notebook_id = ? and topic is not null group by topic",
    )
    .all(notebookId) as { topic: string; n: number }[])
    get(r.topic).cards += r.n;
  for (const r of db
    .prepare(
      "select topic, grade, attempted_at from quiz_attempts where notebook_id = ? and topic is not null",
    )
    .all(notebookId) as { topic: string; grade: number; attempted_at: number }[])
    get(r.topic).attempts.push({ grade: r.grade, at: r.attempted_at });
  for (const r of db
    .prepare(
      `select s.topics from summaries s join notebook_sources ns on ns.document_id = s.document_id
       where ns.notebook_id = ? and s.level = 'document'`,
    )
    .all(notebookId) as { topics: string }[])
    for (const t of JSON.parse(r.topics || "[]") as string[]) if (t.trim()) get(t).docs++;
  return [...topics.entries()].map(([topic, v]) => ({
    topic,
    weakness: weaknessOf(v.attempts, now),
    attempts: v.attempts.length,
    cards: v.cards,
    coverage: v.cards + v.docs,
  }));
}

export function countdown(db: Db, notebookId: string, now = Date.now()): Countdown {
  const r = getRow(db, notebookId);
  const exam = examDates(db, r, now)[0] ?? null;
  const ranked = topicWeakness(db, notebookId, now).sort(
    (a, b) => b.weakness * Math.log2(2 + b.coverage) - a.weakness * Math.log2(2 + a.coverage),
  );
  const due = (
    db
      .prepare(
        "select count(*) n from cards where notebook_id = ? and suspended = 0 and introduced_at is not null and due_at <= ?",
      )
      .get(notebookId, now + DAY) as { n: number }
  ).n;
  return {
    exam,
    daysLeft: exam ? Math.max(0, Math.ceil((exam.at - now) / DAY)) : null,
    topics: ranked.slice(0, 10).map(({ coverage: _c, ...t }) => t),
    plan: { cards: Math.min(due + 10, 60), quizTopics: ranked.slice(0, 2).map((t) => t.topic) },
  };
}

/**
 * Upcoming deadlines (exams, commitments, calendar events) with the lectures most related to each,
 * by embedding similarity within the notebook.
 */
export async function workload(
  db: Db,
  notebookId: string,
  embedder: Embedder | undefined,
  now = Date.now(),
): Promise<WorkloadItem[]> {
  const r = getRow(db, notebookId);
  const items: Omit<WorkloadItem, "related">[] = examDates(db, r, now).map((e) => ({
    kind: "exam" as const,
    title: e.title,
    due: e.at,
    documentId: null,
  }));
  for (const c of db
    .prepare(
      `select c.text, c.deadline, c.source_document_id from commitments c
       join notebook_sources ns on ns.document_id = c.source_document_id and ns.notebook_id = ?
       where c.deadline is not null and c.deadline >= ? and c.status in ('open', 'waiting') order by c.deadline`,
    )
    .all(notebookId, now - DAY) as { text: string; deadline: number; source_document_id: string }[])
    items.push({
      kind: "commitment",
      title: c.text,
      due: c.deadline,
      documentId: c.source_document_id,
    });
  for (const e of db
    .prepare(
      `select d.id, d.title, d.meta from documents d join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where d.source_type = 'calendar'`,
    )
    .all(notebookId) as { id: string; title: string; meta: string }[]) {
    const at = Date.parse((JSON.parse(e.meta || "{}") as { start?: string }).start ?? "");
    if (
      Number.isFinite(at) &&
      at >= now &&
      !items.some((i) => i.title === e.title && Math.abs(i.due - at) < DAY)
    )
      items.push({ kind: "event", title: e.title, due: at, documentId: e.id });
  }
  items.sort((a, b) => a.due - b.due);
  const out: WorkloadItem[] = [];
  for (const item of items.slice(0, 30)) {
    let related: WorkloadItem["related"] = [];
    if (embedder) {
      const [q] = await embedder.embed([item.title], "query");
      if (q) {
        const seqs = searchVec(db, q, { notebookIds: [notebookId] }, 40);
        const seen = new Map<string, { title: string; score: number }>();
        seqs.forEach((seq, rank) => {
          const d = db
            .prepare(
              "select d.id, d.title, d.source_type from chunks c join documents d on d.id = c.document_id where c.seq = ?",
            )
            .get(seq) as { id: string; title: string; source_type: string } | undefined;
          if (
            !d ||
            d.id === item.documentId ||
            !["meeting", "transcript", "pdf", "markdown", "text"].includes(d.source_type)
          )
            return;
          if (!seen.has(d.id)) seen.set(d.id, { title: d.title, score: 1 / (1 + rank) });
        });
        related = [...seen.entries()].slice(0, 3).map(([documentId, v]) => ({ documentId, ...v }));
      }
    }
    out.push({ ...item, related });
  }
  return out;
}

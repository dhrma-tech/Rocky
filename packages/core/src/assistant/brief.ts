import type { AskEvent, Brief, BriefFact, PathInfo } from "@rocky/contracts";
import { ulid } from "ulid";
import { countdown, workload } from "../notebooks/insights.ts";
import { anyLocalOnly } from "../notebooks/scope.ts";
import { getNotebook } from "../notebooks/service.ts";
import {
  chunksById,
  documentChunks,
  type RetrievedChunk,
  retrieve,
} from "../retrieval/retrieve.ts";
import type { Embedder } from "../router/embed.ts";
import type { Router } from "../router/router.ts";
import type { Db } from "../store/db.ts";
import { tokenJaccard } from "../text/similarity.ts";
import { answerOverChunks } from "./verified.ts";

/**
 * Briefs (assistant.md "Briefs"): before a meeting or a class, the context worth knowing,
 * collected from memory (not searched), then written and verified like an Ask answer. Dates and
 * countdowns are computed and returned as facts, so the model never states them.
 */

export interface BriefDeps {
  db: Db;
  router: Router;
  embedder?: Embedder;
}

const DAY = 86_400_000;
/** Context cap: a brief is short, and local models have a small window. */
const MAX_CHUNKS = 14;

const EVENT_SYSTEM =
  "You prepare a short brief for an upcoming meeting from the user's own records: what was discussed recently with the people attending, open commitments involving them, and open questions from earlier sessions. Write 3 to 8 sentences, most useful first. Do not restate the meeting time.";

const CLASS_SYSTEM =
  "You prepare a short brief before a class from the student's own course material: what the last lecture covered and what is due. Write 3 to 8 sentences, most useful first. Do not restate dates or countdowns.";

interface EventRow {
  id: string;
  title: string;
  meta: string;
  external_id: string | null;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Most recent documents (not calendar events) that mention any of the emails. */
function documentsMentioning(db: Db, emails: string[], exclude: string, limit: number): string[] {
  if (!emails.length) return [];
  const where = emails.map(() => "instr(lower(d.raw_text), ?) > 0").join(" or ");
  return (
    db
      .prepare(
        `select d.id from documents d where d.id <> ? and d.source_type <> 'calendar' and (${where})
         order by coalesce(d.updated_at, d.created_at, d.ingested_at) desc limit ?`,
      )
      .all(exclude, ...emails, limit) as { id: string }[]
  ).map((r) => r.id);
}

/** The chunk holding a commitment's evidence quote (so it can be cited). */
function evidenceChunk(db: Db, documentId: string, quote: string): string | null {
  const r = db
    .prepare(
      "select id from chunks where document_id = ? and instr(lower(text), lower(?)) > 0 order by seq limit 1",
    )
    .get(documentId, quote.slice(0, 120)) as { id: string } | undefined;
  return r?.id ?? null;
}

function openCommitments(
  db: Db,
  opts: { emails?: string[]; documentIds?: string[]; dueBefore?: number },
): {
  id: string;
  text: string;
  deadline: number | null;
  documentId: string;
  chunkId: string | null;
}[] {
  const ors: string[] = [];
  const params: unknown[] = [];
  if (opts.emails?.length) {
    const m = opts.emails.map(() => "?").join(",");
    ors.push(
      `exists (select 1 from entities e where (e.id = c.owner_entity_id or e.id = c.counterparty_entity_id) and lower(e.primary_email) in (${m}))`,
    );
    params.push(...opts.emails);
  }
  if (opts.documentIds?.length) {
    ors.push(`c.source_document_id in (${opts.documentIds.map(() => "?").join(",")})`);
    params.push(...opts.documentIds);
  }
  if (!ors.length) return [];
  const due = opts.dueBefore !== undefined ? "and (c.deadline is null or c.deadline <= ?)" : "";
  if (opts.dueBefore !== undefined) params.push(opts.dueBefore);
  const rows = db
    .prepare(
      `select c.id, c.text, c.deadline, c.source_document_id, c.evidence_quote from commitments c
       where c.status in ('open', 'waiting') and (${ors.join(" or ")}) ${due}
       order by coalesce(c.deadline, 9e15) limit 8`,
    )
    .all(...params) as {
    id: string;
    text: string;
    deadline: number | null;
    source_document_id: string;
    evidence_quote: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    deadline: r.deadline,
    documentId: r.source_document_id,
    chunkId: evidenceChunk(db, r.source_document_id, r.evidence_quote),
  }));
}

/** Earlier sessions of the same series: same recurring id, else a similar title. */
function earlierSessions(db: Db, ev: EventRow, startsAt: number | null): string[] {
  const meta = parse<{ recurringEventId?: string }>(ev.meta, {});
  const before = startsAt ?? Date.now();
  const meetings = db
    .prepare(
      "select m.document_id, m.title, m.summary, m.started_at, m.calendar_event_external_id from meetings m where m.started_at < ? order by m.started_at desc limit 50",
    )
    .all(before) as {
    document_id: string;
    title: string;
    summary: string | null;
    started_at: number;
    calendar_event_external_id: string | null;
  }[];
  const series = meta.recurringEventId
    ? new Set(
        (
          db
            .prepare(
              "select external_id from documents where source_type = 'calendar' and json_extract(meta, '$.recurringEventId') = ?",
            )
            .all(meta.recurringEventId) as { external_id: string }[]
        ).map((r) => r.external_id),
      )
    : new Set<string>();
  return meetings
    .filter(
      (m) =>
        (m.calendar_event_external_id && series.has(m.calendar_event_external_id)) ||
        tokenJaccard(m.title, ev.title) >= 0.5,
    )
    .slice(0, 2)
    .map((m) => m.document_id);
}

/** Chunks of an earlier meeting that discuss its open questions (they are model-written, not quotable). */
async function openQuestionChunks(
  deps: BriefDeps,
  meetingDocIds: string[],
): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];
  for (const docId of meetingDocIds) {
    const m = deps.db.prepare("select summary from meetings where document_id = ?").get(docId) as
      | { summary: string | null }
      | undefined;
    const questions = parse<{ openQuestions?: string[] }>(m?.summary, {}).openQuestions ?? [];
    if (!questions.length) continue;
    out.push(
      ...(await retrieve(deps.db, questions.join(" "), {
        scope: { documentIds: [docId] },
        ...(deps.embedder ? { embedder: deps.embedder } : {}),
        tokenBudget: 800,
      })),
    );
  }
  return out;
}

const uniq = (chunks: RetrievedChunk[]) => {
  const seen = new Set<string>();
  return chunks.filter((c) => !seen.has(c.id) && seen.add(c.id)).slice(0, MAX_CHUNKS);
};

function store(db: Db, b: Brief): Brief {
  db.prepare(
    `insert into briefs (id, kind, subject_id, title, starts_at, facts, output, not_found, path, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.id,
    b.kind,
    b.subjectId,
    b.title,
    b.startsAt,
    JSON.stringify(b.facts),
    JSON.stringify(b.answer),
    b.notFound ? 1 : 0,
    b.path ? JSON.stringify(b.path) : null,
    b.createdAt,
  );
  return b;
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export async function briefForEvent(
  deps: BriefDeps,
  eventId: string,
  opts: { now?: number; onEvent?: (e: AskEvent) => void } = {},
): Promise<Brief> {
  const now = opts.now ?? Date.now();
  const ev = deps.db
    .prepare(
      "select id, title, meta, external_id from documents where id = ? and source_type = 'calendar'",
    )
    .get(eventId) as EventRow | undefined;
  if (!ev) throw Object.assign(new Error("Calendar event not found"), { code: "NOT_FOUND" });
  const meta = parse<{ start?: string; attendeeEmails?: string[] }>(ev.meta, {});
  const startsAt = meta.start ? Date.parse(meta.start) : Number.NaN;
  const emails = (meta.attendeeEmails ?? []).map((e) => e.toLowerCase());

  const related = documentsMentioning(deps.db, emails, ev.id, 3);
  const commitments = openCommitments(deps.db, { emails, documentIds: related });
  const earlier = earlierSessions(deps.db, ev, Number.isNaN(startsAt) ? null : startsAt);
  const chunks = uniq([
    ...documentChunks(deps.db, [ev.id], 1),
    ...chunksById(
      deps.db,
      commitments.flatMap((c) => (c.chunkId ? [c.chunkId] : [])),
    ),
    ...(await openQuestionChunks(deps, earlier)),
    ...documentChunks(deps.db, related, 2),
  ]);
  const facts: BriefFact[] = commitments
    .filter((c) => c.deadline !== null)
    .map((c) => ({ label: "Due", detail: c.text, at: c.deadline, documentId: c.documentId }));

  const v = await answerOverChunks(deps, {
    task: "routine",
    origin: "user_turn",
    system: EVENT_SYSTEM,
    prompt: `Meeting: ${ev.title}${Number.isNaN(startsAt) ? "" : ` at ${fmt(startsAt)}`}.${emails.length ? ` Attendees: ${emails.join(", ")}.` : ""}\nWrite the brief.`,
    chunks,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  return store(deps.db, {
    id: ulid(),
    kind: "event",
    subjectId: ev.id,
    title: ev.title,
    startsAt: Number.isNaN(startsAt) ? null : startsAt,
    facts,
    answer: v.answer,
    notFound: v.notFound,
    path: v.path as PathInfo | null,
    createdAt: now,
  });
}

/** Next start of a weekly slot after `now` (local time). */
export function nextSlotStart(
  schedule: { day: number; start: string }[],
  now: number,
): number | null {
  let best: number | null = null;
  for (const s of schedule) {
    const [h = 0, m = 0] = s.start.split(":").map(Number);
    const d = new Date(now);
    const t = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + ((s.day - d.getDay() + 7) % 7),
      h,
      m,
    );
    const at = t.getTime() <= now ? t.getTime() + 7 * DAY : t.getTime();
    if (best === null || at < best) best = at;
  }
  return best;
}

export async function briefForNotebook(
  deps: BriefDeps,
  notebookId: string,
  opts: { now?: number; onEvent?: (e: AskEvent) => void } = {},
): Promise<Brief> {
  const now = opts.now ?? Date.now();
  const nb = getNotebook(deps.db, notebookId);
  const lecture = deps.db
    .prepare(
      `select d.id from documents d join notebook_sources ns on ns.document_id = d.id and ns.notebook_id = ?
       where d.source_type in ('transcript', 'meeting') order by coalesce(d.created_at, d.ingested_at) desc limit 1`,
    )
    .get(notebookId) as { id: string } | undefined;
  const items = await workload(deps.db, notebookId, deps.embedder, now);
  const soon = items.filter((i) => i.due <= now + 14 * DAY);
  const cd = countdown(deps.db, notebookId, now);

  const facts: BriefFact[] = [
    ...(cd.exam && cd.daysLeft !== null
      ? [
          {
            label: "Exam",
            detail: `${cd.exam.title}: ${cd.daysLeft} day${cd.daysLeft === 1 ? "" : "s"} left${
              cd.topics.length
                ? `; weakest: ${cd.topics
                    .slice(0, 3)
                    .map((t) => t.topic)
                    .join(", ")}`
                : ""
            }`,
            at: cd.exam.at,
            documentId: null,
          },
        ]
      : []),
    ...soon
      .filter((i) => i.kind !== "exam")
      .map((i) => ({ label: "Due", detail: i.title, at: i.due, documentId: i.documentId })),
  ];
  const chunks = uniq([
    ...(lecture
      ? await retrieve(deps.db, "main ideas, definitions and announcements of this lecture", {
          scope: { documentIds: [lecture.id] },
          ...(deps.embedder ? { embedder: deps.embedder } : {}),
          tokenBudget: 1800,
        })
      : []),
    ...documentChunks(
      deps.db,
      soon.flatMap((i) => (i.documentId ? [i.documentId] : [])),
      1,
    ),
  ]);
  const v = await answerOverChunks(deps, {
    task: "routine",
    origin: "user_turn",
    system: CLASS_SYSTEM,
    prompt: `Course: ${nb.name}.\nWrite the brief for the next class.`,
    chunks,
    localOnly: anyLocalOnly(deps.db, [notebookId]),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  return store(deps.db, {
    id: ulid(),
    kind: "notebook",
    subjectId: notebookId,
    title: nb.name,
    startsAt: nextSlotStart(nb.schedule, now),
    facts,
    answer: v.answer,
    notFound: v.notFound,
    path: v.path as PathInfo | null,
    createdAt: now,
  });
}

export function latestBrief(db: Db, kind: "event" | "notebook", subjectId: string): Brief | null {
  const r = db
    .prepare(
      "select * from briefs where kind = ? and subject_id = ? order by created_at desc limit 1",
    )
    .get(kind, subjectId) as
    | {
        id: string;
        kind: "event" | "notebook";
        subject_id: string;
        title: string;
        starts_at: number | null;
        facts: string;
        output: string;
        not_found: number;
        path: string | null;
        created_at: number;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    subjectId: r.subject_id,
    title: r.title,
    startsAt: r.starts_at,
    facts: parse(r.facts, []),
    answer: parse(r.output, []),
    notFound: r.not_found === 1,
    path: parse(r.path, null),
    createdAt: r.created_at,
  };
}

import type { ExamDate, TimelineItem } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { tokenJaccard } from "../text/similarity.ts";

/**
 * Unified timeline (assistant.md): calendar events, Notion rows with dates, GitHub milestones,
 * commitments with deadlines and manual exam dates, normalized and merged when two sources
 * describe the same thing (similar title, same time). Read-only: built from synced documents.
 */

const DAY = 86_400_000;
/** Items closer than this with similar titles are the same thing seen twice. */
const SAME_TIME_MS = 60 * 60_000;
const SAME_TITLE = 0.6;
/** Which source wins when merging (the most precise first). */
const PRIORITY = ["gcal", "notion", "github", "notebooks", "commitments"];

const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "2026-10-07" is local midnight (Date.parse would read it as UTC); full timestamps parse as is. */
export function parseWhen(s: string | undefined | null): { at: number; allDay: boolean } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m)
    return { at: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), allDay: true };
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : { at, allDay: false };
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

interface DocRow {
  id: string;
  title: string;
  uri: string | null;
  connector_id: string | null;
  meta: string;
}

export function timeline(db: Db, range: { from: number; to: number }): TimelineItem[] {
  const { from, to } = range;
  const inRange = (at: number) => at >= from && at < to;
  // Dates are ISO strings in meta; the SQL prefilter works on the date part, a day wider each side.
  const lo = ymd(from - DAY);
  const hi = ymd(to + DAY);
  const items: TimelineItem[] = [];

  for (const d of db
    .prepare(
      `select id, title, uri, connector_id, meta from documents
       where source_type = 'calendar' and substr(json_extract(meta, '$.start'), 1, 10) between ? and ?`,
    )
    .all(lo, hi) as DocRow[]) {
    const meta = parse<{ start?: string; end?: string }>(d.meta, {});
    const start = parseWhen(meta.start);
    if (!start || !inRange(start.at)) continue;
    const end = parseWhen(meta.end);
    items.push({
      kind: "event",
      title: d.title,
      start: start.at,
      end: end?.at ?? null,
      due: null,
      allDay: start.allDay,
      source: d.connector_id ?? "calendar",
      deepLink: d.uri,
      documentId: d.id,
      mergedFrom: [],
    });
  }

  for (const d of db
    .prepare(
      `select id, title, uri, connector_id, meta from documents
       where source_type = 'notion' and json_extract(meta, '$.kind') = 'row'
         and exists (select 1 from json_each(json_extract(meta, '$.dates')) x
                     where substr(json_extract(x.value, '$.start'), 1, 10) between ? and ?)`,
    )
    .all(lo, hi) as DocRow[]) {
    const dates = parse<{ dates?: { name: string; start: string; end: string | null }[] }>(
      d.meta,
      {},
    ).dates;
    for (const dt of dates ?? []) {
      const start = parseWhen(dt.start);
      if (!start || !inRange(start.at)) continue;
      items.push({
        kind: "notion",
        title: (dates?.length ?? 0) > 1 ? `${d.title} (${dt.name})` : d.title,
        start: start.at,
        end: parseWhen(dt.end)?.at ?? null,
        due: start.at,
        allDay: start.allDay,
        source: d.connector_id ?? "notion",
        deepLink: d.uri,
        documentId: d.id,
        mergedFrom: [],
      });
    }
  }

  for (const d of db
    .prepare(
      `select id, title, uri, connector_id, meta from documents
       where source_type = 'github' and json_extract(meta, '$.state') = 'open'
         and substr(json_extract(meta, '$.dueOn'), 1, 10) between ? and ?`,
    )
    .all(lo, hi) as DocRow[]) {
    const meta = parse<{ dueOn?: string; milestone?: string }>(d.meta, {});
    const due = parseWhen(meta.dueOn);
    if (!due || !inRange(due.at)) continue;
    items.push({
      kind: "task",
      title: meta.milestone ? `${d.title} (${meta.milestone})` : d.title,
      start: due.at,
      end: null,
      due: due.at,
      allDay: false,
      source: d.connector_id ?? "github",
      deepLink: d.uri,
      documentId: d.id,
      mergedFrom: [],
    });
  }

  for (const c of db
    .prepare(
      `select c.text, c.deadline, c.source_document_id, d.uri from commitments c
       join documents d on d.id = c.source_document_id
       where c.status in ('open', 'waiting') and c.deadline >= ? and c.deadline < ?`,
    )
    .all(from, to) as {
    text: string;
    deadline: number;
    source_document_id: string;
    uri: string | null;
  }[])
    items.push({
      kind: "commitment",
      title: c.text,
      start: c.deadline,
      end: null,
      due: c.deadline,
      allDay: false,
      source: "commitments",
      deepLink: c.uri,
      documentId: c.source_document_id,
      mergedFrom: [],
    });

  for (const n of db.prepare("select name, exam_dates from notebooks").all() as {
    name: string;
    exam_dates: string | null;
  }[])
    for (const e of parse<ExamDate[]>(n.exam_dates, []))
      if (inRange(e.at))
        items.push({
          kind: "exam",
          title: `${n.name}: ${e.title}`,
          start: e.at,
          end: null,
          due: e.at,
          allDay: false,
          source: "notebooks",
          deepLink: null,
          documentId: null,
          mergedFrom: [],
        });

  return mergeDuplicates(items);
}

const rank = (s: string) => {
  const i = PRIORITY.indexOf(s);
  return i === -1 ? PRIORITY.length : i;
};

/** Same thing from two sources (similar title, within an hour or the same all-day date) → one item. */
export function mergeDuplicates(items: TimelineItem[]): TimelineItem[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || rank(a.source) - rank(b.source));
  const out: TimelineItem[] = [];
  for (const it of sorted) {
    const twin = out.find(
      (o) =>
        o.source !== it.source &&
        (o.allDay || it.allDay
          ? ymd(o.start) === ymd(it.start)
          : Math.abs(o.start - it.start) < SAME_TIME_MS) &&
        tokenJaccard(o.title, it.title) >= SAME_TITLE,
    );
    if (!twin) {
      out.push({ ...it, mergedFrom: [] });
      continue;
    }
    if (rank(it.source) < rank(twin.source)) {
      const merged = { ...it, mergedFrom: [twin.source, ...twin.mergedFrom] };
      out.splice(out.indexOf(twin), 1, merged);
    } else if (!twin.mergedFrom.includes(it.source)) twin.mergedFrom.push(it.source);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Today in local time. */
export function dayRange(now: number): { from: number; to: number } {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { from, to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
}

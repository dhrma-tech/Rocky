import {
  type ExamDate,
  type Notebook,
  type NotebookCreate,
  NotebookCreateSchema,
  type NotebookScope,
  NotebookScopeSchema,
  type NotebookSource,
  type NotebookUpdate,
  type ScheduleSlot,
  type ScopeRules,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { appendAudit } from "../audit/append.ts";
import { deleteData } from "../deletion/service.ts";
import type { Db } from "../store/db.ts";
import { materialize, ruleDocuments } from "./scope.ts";

/** Notebooks CRUD, sources, exam dates and the recorder's default notebook (notebooks.md). */

export class NotebookError extends Error {
  readonly code: "NOT_FOUND" | "BAD_REQUEST";
  constructor(code: NotebookError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const MATURE_DAYS = 21;

interface Row {
  id: string;
  name: string;
  kind: Notebook["kind"];
  term: string | null;
  instructor: string | null;
  schedule: string;
  scope: string;
  exam_dates: string;
  exam_tag: string | null;
  local_only: number;
  capture_default: number;
  created_at: number;
}

const parseScope = (s: string): NotebookScope =>
  NotebookScopeSchema.catch({ documentIds: [], excludedIds: [], rules: {} }).parse(
    JSON.parse(s || "{}"),
  );

export function getRow(db: Db, id: string): Row {
  const r = db.prepare("select * from notebooks where id = ?").get(id) as Row | undefined;
  if (!r) throw new NotebookError("NOT_FOUND", "Notebook not found");
  return r;
}

/**
 * Exam dates: manual ones plus calendar events whose title has the exam tag ("exam") and names
 * this course (its name or one of its title-match codes). Future dates only, soonest first.
 */
export function examDates(db: Db, r: Row, now = Date.now()): ExamDate[] {
  const manual = (JSON.parse(r.exam_dates || "[]") as ExamDate[]).filter(
    (e) => e.at >= now - 86_400_000,
  );
  const tag = (r.exam_tag || "exam").toLowerCase();
  const names = [r.name, ...(parseScope(r.scope).rules.titleMatches ?? [])].map((s) =>
    s.toLowerCase(),
  );
  const events = (
    db
      .prepare(
        "select title, meta from documents where source_type = 'calendar' and instr(lower(title), ?) > 0",
      )
      .all(tag) as { title: string; meta: string }[]
  )
    .filter((e) => names.some((n) => n && e.title.toLowerCase().includes(n)))
    .map((e) => ({
      title: e.title,
      at: Date.parse((JSON.parse(e.meta || "{}") as { start?: string }).start ?? ""),
    }))
    .filter((e) => Number.isFinite(e.at) && e.at >= now);
  const seen = new Set<string>();
  return [...manual, ...events]
    .sort((a, b) => a.at - b.at)
    .filter((e) => {
      const k = `${e.title}|${new Date(e.at).toISOString().slice(0, 10)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

function view(db: Db, r: Row, now = Date.now()): Notebook {
  const counts = db
    .prepare(
      `select (select count(*) from notebook_sources where notebook_id = ?) as sources,
              (select count(*) from cards where notebook_id = ? and suspended = 0) as cards,
              (select count(*) from cards where notebook_id = ? and suspended = 0 and due_at is not null and due_at <= ?) as due,
              (select count(*) from cards where notebook_id = ? and suspended = 0 and interval_days >= ?) as mature`,
    )
    .get(r.id, r.id, r.id, now, r.id, MATURE_DAYS) as {
    sources: number;
    cards: number;
    due: number;
    mature: number;
  };
  const exams = examDates(db, r, now);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    term: r.term,
    instructor: r.instructor,
    schedule: JSON.parse(r.schedule || "[]") as ScheduleSlot[],
    examDates: JSON.parse(r.exam_dates || "[]") as ExamDate[],
    examTag: r.exam_tag ?? "exam",
    localOnly: r.local_only === 1,
    captureDefault: r.capture_default === 1,
    scope: parseScope(r.scope),
    createdAt: r.created_at,
    sourceCount: counts.sources,
    cardCount: counts.cards,
    dueCount: counts.due,
    mastery: counts.cards ? counts.mature / counts.cards : 0,
    nextExam: exams[0] ?? null,
  };
}

export function listNotebooks(db: Db): Notebook[] {
  return (db.prepare("select * from notebooks order by created_at desc").all() as Row[]).map((r) =>
    view(db, r),
  );
}

export function getNotebook(db: Db, id: string): Notebook {
  return view(db, getRow(db, id));
}

export function createNotebook(db: Db, input: NotebookCreate, now = Date.now()): Notebook {
  const p = NotebookCreateSchema.parse(input);
  const id = ulid(now);
  db.prepare(
    `insert into notebooks (id, name, kind, term, instructor, schedule, scope, exam_dates, exam_tag, local_only,
     capture_default, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    p.name,
    p.kind,
    p.term,
    p.instructor,
    JSON.stringify(p.schedule),
    JSON.stringify(p.scope),
    JSON.stringify(p.examDates),
    p.examTag,
    p.localOnly ? 1 : 0,
    p.captureDefault ? 1 : 0,
    now,
  );
  materialize(db, id);
  appendAudit(db, {
    eventType: "notebook_created",
    actor: "user",
    subjectType: "notebook",
    subjectId: id,
  });
  return getNotebook(db, id);
}

export function updateNotebook(db: Db, id: string, patch: NotebookUpdate): Notebook {
  const r = getRow(db, id);
  const cols: Record<string, unknown> = {};
  if (patch.name !== undefined) cols.name = patch.name;
  if (patch.kind !== undefined) cols.kind = patch.kind;
  if (patch.term !== undefined) cols.term = patch.term;
  if (patch.instructor !== undefined) cols.instructor = patch.instructor;
  if (patch.schedule !== undefined) cols.schedule = JSON.stringify(patch.schedule);
  if (patch.examDates !== undefined) cols.exam_dates = JSON.stringify(patch.examDates);
  if (patch.examTag !== undefined) cols.exam_tag = patch.examTag;
  if (patch.localOnly !== undefined) cols.local_only = patch.localOnly ? 1 : 0;
  if (patch.captureDefault !== undefined) cols.capture_default = patch.captureDefault ? 1 : 0;
  if (patch.scope !== undefined) cols.scope = JSON.stringify(patch.scope);
  const keys = Object.keys(cols);
  if (keys.length)
    db.prepare(`update notebooks set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`).run(
      ...Object.values(cols),
      id,
    );
  if (patch.scope !== undefined) materialize(db, id);
  if (patch.localOnly !== undefined && patch.localOnly !== (r.local_only === 1))
    appendAudit(db, {
      eventType: "notebook_local_only",
      actor: "user",
      subjectType: "notebook",
      subjectId: id,
      meta: { localOnly: patch.localOnly },
    });
  return getNotebook(db, id);
}

export function deleteNotebook(db: Db, blobsDir: string, id: string, withSources = false) {
  getRow(db, id);
  return deleteData(db, blobsDir, { notebookId: id, withSources });
}

export function notebookSources(db: Db, id: string): NotebookSource[] {
  getRow(db, id);
  const rows = db
    .prepare(
      `select d.id, d.title, d.source_type, d.connector_id, d.updated_at, d.uri, ns.added_by
       from notebook_sources ns join documents d on d.id = ns.document_id
       where ns.notebook_id = ? order by coalesce(d.updated_at, d.created_at) desc`,
    )
    .all(id) as {
    id: string;
    title: string;
    source_type: string;
    connector_id: string | null;
    updated_at: number | null;
    uri: string | null;
    added_by: "rule" | "manual";
  }[];
  return rows.map((r) => ({
    documentId: r.id,
    title: r.title,
    sourceType: r.source_type,
    connectorId: r.connector_id,
    addedBy: r.added_by,
    updatedAt: r.updated_at,
    uri: r.uri,
  }));
}

/** Adds a document by hand; it also lifts a previous manual removal. */
export function addSource(db: Db, id: string, documentId: string): Notebook {
  if (!db.prepare("select 1 from documents where id = ?").get(documentId))
    throw new NotebookError("NOT_FOUND", "Document not found");
  const scope = parseScope(getRow(db, id).scope);
  const next: NotebookScope = {
    ...scope,
    documentIds: [...new Set([...scope.documentIds, documentId])],
    excludedIds: scope.excludedIds.filter((x) => x !== documentId),
  };
  return updateNotebook(db, id, { scope: next });
}

/** Removes a document; rules won't bring it back. */
export function removeSource(db: Db, id: string, documentId: string): Notebook {
  const scope = parseScope(getRow(db, id).scope);
  const next: NotebookScope = {
    ...scope,
    documentIds: scope.documentIds.filter((x) => x !== documentId),
    excludedIds: [...new Set([...scope.excludedIds, documentId])],
  };
  db.prepare("delete from notebook_sources where notebook_id = ? and document_id = ?").run(
    id,
    documentId,
  );
  return updateNotebook(db, id, { scope: next });
}

/** How many documents (and which) a rule set selects, before saving it. */
export function previewScope(
  db: Db,
  rules: ScopeRules,
): { count: number; sample: { id: string; title: string }[] } {
  const ids = ruleDocuments(db, rules);
  const sample = ids.slice(0, 10).map((id) => {
    const d = db.prepare("select title from documents where id = ?").get(id) as { title: string };
    return { id, title: d.title };
  });
  return { count: ids.length, sample };
}

const minutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** The notebook whose scheduled slot is now, among those that capture by default (recorder default). */
export function currentSlotNotebook(db: Db, now = new Date()): { id: string; name: string } | null {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const r of db
    .prepare("select id, name, schedule from notebooks where capture_default = 1")
    .all() as {
    id: string;
    name: string;
    schedule: string;
  }[]) {
    const slots = JSON.parse(r.schedule || "[]") as ScheduleSlot[];
    // A few minutes of slack: recording often starts just before the slot.
    if (slots.some((s) => s.day === day && mins >= minutes(s.start) - 10 && mins <= minutes(s.end)))
      return { id: r.id, name: r.name };
  }
  return null;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AnswerSentence,
  type PathInfo,
  type Routine,
  type RoutineCreate,
  RoutineCreateSchema,
  type RoutineInput,
  RoutineInputSchema,
  type RoutineRun,
  type RoutineUpdate,
} from "@rocky/contracts";
import { Cron } from "croner";
import { ulid } from "ulid";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { enqueue, type Job } from "../jobs/queue.ts";
import type { JobHandler } from "../jobs/runner.ts";
import { chunksById, documentChunks, type RetrievedChunk } from "../retrieval/retrieve.ts";
import type { Router } from "../router/router.ts";
import type { Db } from "../store/db.ts";
import { dayRange, timeline } from "./timeline.ts";
import { answerOverChunks } from "./verified.ts";

/**
 * Routines (assistant.md "Routines"): templates from packs, a cron schedule, named context
 * collectors, and a verified, cited output stored per run. Routines only write; they never act.
 * A run missed while the machine slept catches up once (only the latest missed time runs).
 */

export const ROUTINE_JOB = "routine";
const DAY = 86_400_000;
const MAX_CHUNKS = 16;

/** Shipped packs; `<dataDir>/templates` files with the same path win. */
export const repoTemplatesDir = fileURLToPath(new URL("../../../../templates/", import.meta.url));

const TemplateRoutineSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(9),
  inputs: z.array(RoutineInputSchema).min(1),
  prompt: z.string().regex(/^prompts\/[\w-]+\.md$/),
});

export interface TemplateRoutine {
  pack: string;
  template: string;
  name: string;
  schedule: string;
  inputs: RoutineInput[];
  promptFile: string;
}

export interface TemplatePack {
  id: string;
  name: string;
  description: string;
  routines: TemplateRoutine[];
}

/** The file to use: the user's override if present, else the shipped one. */
function resolveFile(dataDir: string | undefined, rel: string): string | null {
  for (const base of [dataDir ? path.join(dataDir, "templates") : null, repoTemplatesDir]) {
    if (!base) continue;
    const f = path.join(base, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function listPacks(dataDir?: string): TemplatePack[] {
  const ids = new Set<string>();
  for (const base of [repoTemplatesDir, dataDir ? path.join(dataDir, "templates") : null])
    if (base && fs.existsSync(base))
      for (const e of fs.readdirSync(base, { withFileTypes: true }))
        if (e.isDirectory() && fs.existsSync(path.join(base, e.name, "pack.yaml"))) ids.add(e.name);
  return [...ids].sort().map((id) => {
    const packFile = resolveFile(dataDir, path.join(id, "pack.yaml"));
    const pack = (packFile ? parseYaml(fs.readFileSync(packFile, "utf8")) : {}) as {
      name?: string;
      description?: string;
    };
    const names = new Set<string>();
    for (const base of [repoTemplatesDir, dataDir ? path.join(dataDir, "templates") : null]) {
      const dir = base ? path.join(base, id, "routines") : null;
      if (dir && fs.existsSync(dir))
        for (const f of fs.readdirSync(dir)) if (f.endsWith(".yaml")) names.add(f.slice(0, -5));
    }
    const routines: TemplateRoutine[] = [];
    for (const template of [...names].sort()) {
      const file = resolveFile(dataDir, path.join(id, "routines", `${template}.yaml`));
      const r = TemplateRoutineSchema.safeParse(
        file ? parseYaml(fs.readFileSync(file, "utf8")) : null,
      );
      if (!r.success) continue;
      routines.push({
        pack: id,
        template,
        name: r.data.name,
        schedule: r.data.schedule,
        inputs: r.data.inputs,
        promptFile: r.data.prompt,
      });
    }
    return { id, name: pack.name ?? id, description: pack.description ?? "", routines };
  });
}

/** Prompt body without its frontmatter. */
export function promptBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}

function templatePrompt(dataDir: string | undefined, pack: string, promptFile: string): string {
  const f = resolveFile(dataDir, path.join(pack, promptFile));
  return f ? promptBody(fs.readFileSync(f, "utf8")) : "";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function renderPrompt(prompt: string, now: number): string {
  const d = new Date(now);
  const vars: Record<string, string> = {
    // Built by hand: Intl output differs between ICU versions.
    date: `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
  return prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => vars[k] ?? all);
}

// --- schedule ---

const cronOf = (expr: string) => new Cron(expr, { paused: true });

export function validCron(expr: string): boolean {
  try {
    cronOf(expr);
    return true;
  } catch {
    return false;
  }
}

/** The latest scheduled time at or before `now`, or null. */
export function lastScheduled(expr: string, now: number): number | null {
  // croner compares whole seconds: a tick at exactly 07:00:00 must still count 07:00 as due.
  const prev = cronOf(expr).previousRuns(1, new Date(now + 1000))[0];
  return prev ? prev.getTime() : null;
}

export function nextScheduled(expr: string, now: number): number | null {
  return cronOf(expr).nextRun(new Date(now))?.getTime() ?? null;
}

// --- storage ---

interface Row {
  id: string;
  name: string;
  template_ref: string | null;
  schedule_cron: string;
  enabled: number;
  last_run_at: number | null;
  pack: string | null;
  template: string | null;
  inputs: string;
  prompt: string | null;
  created_at: number | null;
}
interface RunRow {
  id: string;
  routine_id: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "done" | "failed";
  output: string | null;
  not_found: number;
  error: string | null;
  path: string | null;
}

const parseJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function toRun(r: RunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    answer: parseJson<AnswerSentence[]>(r.output, []),
    notFound: r.not_found === 1,
    error: r.error,
    path: parseJson<PathInfo | null>(r.path, null),
  };
}

function row(db: Db, id: string): Row {
  const r = db.prepare("select * from routines where id = ?").get(id) as Row | undefined;
  if (!r) throw Object.assign(new Error("Routine not found"), { code: "NOT_FOUND" });
  return r;
}

function toRoutine(db: Db, r: Row, dataDir: string | undefined, now: number): Routine {
  const last = db
    .prepare("select * from routine_runs where routine_id = ? order by started_at desc limit 1")
    .get(r.id) as RunRow | undefined;
  const shipped = r.pack && r.template_ref ? templatePrompt(dataDir, r.pack, r.template_ref) : "";
  return {
    id: r.id,
    name: r.name,
    pack: r.pack,
    template: r.template,
    schedule: r.schedule_cron,
    enabled: r.enabled === 1,
    inputs: parseJson<RoutineInput[]>(r.inputs, []),
    prompt: r.prompt ?? shipped,
    edited: r.prompt !== null && r.pack !== null,
    lastRunAt: r.last_run_at,
    nextRunAt: r.enabled === 1 ? nextScheduled(r.schedule_cron, now) : null,
    lastRun: last ? toRun(last) : null,
  };
}

export function listRoutines(db: Db, opts: { dataDir?: string; now?: number } = {}): Routine[] {
  const now = opts.now ?? Date.now();
  return (db.prepare("select * from routines order by created_at, name").all() as Row[]).map((r) =>
    toRoutine(db, r, opts.dataDir, now),
  );
}

export function getRoutine(
  db: Db,
  id: string,
  opts: { dataDir?: string; now?: number } = {},
): Routine {
  return toRoutine(db, row(db, id), opts.dataDir, opts.now ?? Date.now());
}

/** Adds a pack's routines (switched off). Already added ones are left as they are. */
export function addPackRoutines(
  db: Db,
  packId: string,
  opts: { dataDir?: string; now?: number; only?: string } = {},
): number {
  const pack = listPacks(opts.dataDir).find((p) => p.id === packId);
  if (!pack) throw Object.assign(new Error(`No template pack "${packId}"`), { code: "NOT_FOUND" });
  const insert = db.prepare(
    `insert or ignore into routines (id, name, template_ref, schedule_cron, enabled, pack, template, inputs, created_at)
     values (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const t of pack.routines) {
    if (opts.only && t.template !== opts.only) continue;
    added += insert.run(
      ulid(),
      t.name,
      t.promptFile,
      t.schedule,
      t.pack,
      t.template,
      JSON.stringify(t.inputs),
      opts.now ?? Date.now(),
    ).changes;
  }
  return added;
}

/** First start: the student pack (the primary persona), all switched off. */
export function seedRoutines(db: Db, opts: { dataDir?: string; now?: number } = {}): void {
  const n = (db.prepare("select count(*) as n from routines").get() as { n: number }).n;
  if (n === 0 && listPacks(opts.dataDir).some((p) => p.id === "student"))
    addPackRoutines(db, "student", opts);
}

export function createRoutine(db: Db, input: RoutineCreate, now = Date.now()): string {
  const r = RoutineCreateSchema.parse(input);
  if (!validCron(r.schedule))
    throw Object.assign(new Error("Invalid schedule"), { code: "BAD_REQUEST" });
  const id = ulid();
  db.prepare(
    `insert into routines (id, name, schedule_cron, enabled, inputs, prompt, created_at, last_run_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.name, r.schedule, r.enabled ? 1 : 0, JSON.stringify(r.inputs), r.prompt, now, now);
  return id;
}

export function updateRoutine(db: Db, id: string, patch: RoutineUpdate, now = Date.now()): void {
  const r = row(db, id);
  if (patch.schedule !== undefined && !validCron(patch.schedule))
    throw Object.assign(new Error("Invalid schedule"), { code: "BAD_REQUEST" });
  if (patch.prompt === null && r.pack === null)
    throw Object.assign(new Error("A custom routine needs a prompt"), { code: "BAD_REQUEST" });
  db.prepare(
    `update routines set name = ?, schedule_cron = ?, inputs = ?, prompt = ?, enabled = ?, last_run_at = ? where id = ?`,
  ).run(
    patch.name ?? r.name,
    patch.schedule ?? r.schedule_cron,
    patch.inputs ? JSON.stringify(patch.inputs) : r.inputs,
    patch.prompt === undefined ? r.prompt : patch.prompt,
    patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
    // Switching on does not replay the past: the next scheduled time is the first run.
    patch.enabled && !r.enabled ? now : r.last_run_at,
    id,
  );
}

export function deleteRoutine(db: Db, id: string): void {
  row(db, id);
  db.prepare("delete from routines where id = ?").run(id);
}

export function routineRuns(db: Db, id: string, limit = 20): RoutineRun[] {
  return (
    db
      .prepare("select * from routine_runs where routine_id = ? order by started_at desc limit ?")
      .all(id, limit) as RunRow[]
  ).map(toRun);
}

export function latestRun(db: Db): { routineId: string; name: string; run: RoutineRun } | null {
  const r = db
    .prepare(
      `select rr.*, r.name from routine_runs rr join routines r on r.id = rr.routine_id
       where rr.status = 'done' order by rr.started_at desc limit 1`,
    )
    .get() as (RunRow & { name: string }) | undefined;
  return r ? { routineId: r.routine_id, name: r.name, run: toRun(r) } : null;
}

// --- context collectors ---

function evidenceChunkIds(db: Db, where: string, params: unknown[]): string[] {
  const rows = db
    .prepare(
      `select c.source_document_id as doc, c.evidence_quote as quote from commitments c
       where c.status in ('open', 'waiting') and ${where} order by c.deadline limit 8`,
    )
    .all(...params) as { doc: string; quote: string }[];
  const find = db.prepare(
    "select id from chunks where document_id = ? and instr(lower(text), lower(?)) > 0 order by seq limit 1",
  );
  return rows.flatMap((r) => {
    const hit = find.get(r.doc, r.quote.slice(0, 120)) as { id: string } | undefined;
    return hit ? [hit.id] : [];
  });
}

/** Named inputs → chunks the routine may cite. */
export function collect(db: Db, input: RoutineInput, now: number): RetrievedChunk[] {
  const today = dayRange(now);
  switch (input) {
    case "calendar_today":
      return documentChunks(
        db,
        timeline(db, today).flatMap((i) =>
          i.kind === "event" && i.documentId ? [i.documentId] : [],
        ),
        1,
      );
    case "meetings_today":
    case "week_meetings": {
      const from = input === "meetings_today" ? today.from : now - 7 * DAY;
      const docs = (
        db
          .prepare(
            "select document_id from meetings where started_at >= ? and started_at < ? order by started_at",
          )
          .all(from, today.to) as { document_id: string }[]
      ).map((r) => r.document_id);
      return documentChunks(db, docs, input === "meetings_today" ? 3 : 2);
    }
    case "commitments_due_7d":
      return chunksById(
        db,
        evidenceChunkIds(db, "c.deadline >= ? and c.deadline < ?", [now, now + 7 * DAY]),
      );
    case "overdue":
      return chunksById(db, evidenceChunkIds(db, "c.deadline < ?", [now]));
    case "deadlines_14d":
      return documentChunks(
        db,
        timeline(db, { from: now, to: now + 14 * DAY }).flatMap((i) =>
          i.kind !== "event" && i.documentId ? [i.documentId] : [],
        ),
        1,
      );
    case "unread_important_threads":
      return documentChunks(
        db,
        (
          db
            .prepare(
              `select d.id from documents d where d.source_type = 'email' and coalesce(d.updated_at, d.created_at) >= ?
               and exists (select 1 from json_each(json_extract(d.meta, '$.labels')) l where l.value = 'UNREAD')
               and exists (select 1 from json_each(json_extract(d.meta, '$.labels')) l where l.value = 'IMPORTANT')
               order by d.updated_at desc limit 5`,
            )
            .all(now - 3 * DAY) as { id: string }[]
        ).map((r) => r.id),
        2,
      );
  }
}

// --- runs ---

const ROUTINE_SYSTEM =
  "You write a routine summary for the user from their own records. Follow the routine's instructions. State only what the chunks say; never invent times, names or numbers.";

export interface RoutineDeps {
  db: Db;
  router: Router;
  dataDir?: string;
}

/** Runs one routine now and stores the run (done with sentences, or failed with the reason). */
export async function runRoutine(
  deps: RoutineDeps,
  id: string,
  now = Date.now(),
): Promise<RoutineRun> {
  const { db } = deps;
  const r = getRoutine(db, id, { ...(deps.dataDir ? { dataDir: deps.dataDir } : {}), now });
  const runId = ulid();
  db.prepare(
    "insert into routine_runs (id, routine_id, started_at, status) values (?, ?, ?, 'running')",
  ).run(runId, id, now);
  try {
    const seen = new Set<string>();
    const chunks = r.inputs
      .flatMap((i) => collect(db, i, now))
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .slice(0, MAX_CHUNKS);
    const v = await answerOverChunks(deps, {
      task: "routine",
      origin: `routine:${id}`,
      system: ROUTINE_SYSTEM,
      prompt: `Routine: ${r.name}\n\n${renderPrompt(r.prompt, now)}`,
      chunks,
    });
    db.prepare(
      "update routine_runs set status = 'done', finished_at = ?, output = ?, not_found = ?, path = ?, usage = ? where id = ?",
    ).run(
      Date.now(),
      JSON.stringify(v.answer),
      v.notFound ? 1 : 0,
      v.path ? JSON.stringify(v.path) : null,
      JSON.stringify(v.usage),
      runId,
    );
  } catch (err) {
    db.prepare(
      "update routine_runs set status = 'failed', finished_at = ?, error = ? where id = ?",
    ).run(Date.now(), err instanceof Error ? err.message : String(err), runId);
  }
  db.prepare("update routines set last_run_at = max(coalesce(last_run_at, 0), ?) where id = ?").run(
    now,
    id,
  );
  return toRun(db.prepare("select * from routine_runs where id = ?").get(runId) as RunRow);
}

/**
 * Enabled routines whose latest scheduled time is after their last run. Several missed times
 * still give one run (catch up once). Marks them as run at `now` so the next tick skips them.
 */
export function dueRoutines(db: Db, now = Date.now()): string[] {
  const due: string[] = [];
  for (const r of db.prepare("select * from routines where enabled = 1").all() as Row[]) {
    const at = lastScheduled(r.schedule_cron, now);
    if (at === null) continue;
    if (at > (r.last_run_at ?? r.created_at ?? 0)) due.push(r.id);
  }
  return due;
}

/** Scheduler tick: queue due routines as jobs. Returns the queued routine ids. */
export function queueDueRoutines(db: Db, now = Date.now(), heavy = false): string[] {
  const ids = dueRoutines(db, now);
  for (const id of ids) {
    db.prepare("update routines set last_run_at = ? where id = ?").run(now, id);
    enqueue(db, ROUTINE_JOB, { routineId: id, at: now }, { heavy, priority: 2, maxAttempts: 1 });
  }
  return ids;
}

export function routineJobHandler(deps: RoutineDeps): JobHandler {
  return async (job: Job) => {
    const { routineId, at } = job.payload as { routineId: string; at?: number };
    const run = await runRoutine(deps, routineId, at ?? Date.now());
    if (run.status === "failed") throw new Error(run.error ?? "routine failed");
  };
}

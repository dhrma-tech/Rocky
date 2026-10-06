import { ulid } from "ulid";
import type { Db } from "../store/db.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  heavy: boolean;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string | null;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  priority: number;
  heavy: number;
  attempts: number;
  max_attempts: number;
  run_after: number;
  last_error: string | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  type: r.type,
  payload: JSON.parse(r.payload),
  status: r.status,
  priority: r.priority,
  heavy: r.heavy === 1,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAfter: r.run_after,
  lastError: r.last_error,
});

export interface EnqueueOptions {
  priority?: number;
  heavy?: boolean;
  runAfter?: number;
  maxAttempts?: number;
  now?: number;
}

export function enqueue(db: Db, type: string, payload: unknown, opts: EnqueueOptions = {}): string {
  const now = opts.now ?? Date.now();
  const id = ulid(now);
  db.prepare(
    `insert into jobs (id, type, payload, status, priority, heavy, attempts, max_attempts, run_after, created_at, updated_at)
     values (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    type,
    JSON.stringify(payload ?? {}),
    opts.priority ?? 0,
    opts.heavy ? 1 : 0,
    opts.maxAttempts ?? 3,
    opts.runAfter ?? now,
    now,
    now,
  );
  return id;
}

/** Atomically takes the highest-priority ready job. `heavy` filters to heavy or light jobs. */
export function claimNext(db: Db, opts: { heavy: boolean; now?: number }): Job | undefined {
  const now = opts.now ?? Date.now();
  return db.transaction(() => {
    const row = db
      .prepare(
        `select * from jobs where status = 'queued' and heavy = ? and run_after <= ?
         order by priority desc, created_at limit 1`,
      )
      .get(opts.heavy ? 1 : 0, now) as JobRow | undefined;
    if (!row) return undefined;
    db.prepare(
      "update jobs set status = 'running', attempts = attempts + 1, updated_at = ? where id = ?",
    ).run(now, row.id);
    return toJob({ ...row, status: "running", attempts: row.attempts + 1 });
  })();
}

export function completeJob(db: Db, id: string, now = Date.now()): void {
  db.prepare("update jobs set status = 'done', last_error = null, updated_at = ? where id = ?").run(
    now,
    id,
  );
}

/** Requeues with exponential backoff (5 s, 10 s, 20 s, …) until max attempts, then marks failed. */
export function failJob(db: Db, job: Job, error: string, now = Date.now()): JobStatus {
  const final = job.attempts >= job.maxAttempts;
  const runAfter = now + 5_000 * 2 ** (job.attempts - 1);
  db.prepare(
    "update jobs set status = ?, last_error = ?, run_after = ?, updated_at = ? where id = ?",
  ).run(final ? "failed" : "queued", error.slice(0, 2000), runAfter, now, job.id);
  return final ? "failed" : "queued";
}

/** Jobs left `running` by a crash go back to the queue on startup. */
export function recoverStaleJobs(db: Db, now = Date.now()): number {
  return db
    .prepare("update jobs set status = 'queued', updated_at = ? where status = 'running'")
    .run(now).changes;
}

export function getJob(db: Db, id: string): Job | undefined {
  const row = db.prepare("select * from jobs where id = ?").get(id) as JobRow | undefined;
  return row && toJob(row);
}

/** Records progress (0..1) and a short note for GET /jobs/:id/events. */
export function setJobProgress(db: Db, id: string, progress: number, note?: string): void {
  db.prepare("update jobs set progress = ?, progress_note = ?, updated_at = ? where id = ?").run(
    Math.max(0, Math.min(1, progress)),
    note ?? null,
    Date.now(),
    id,
  );
}

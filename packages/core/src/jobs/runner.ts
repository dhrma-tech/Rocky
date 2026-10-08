import type { AgentState, RunKind } from "@rocky/contracts";
import { recordEvent } from "../events/log.ts";
import type { Db } from "../store/db.ts";
import { claimNext, completeJob, failJob, type Job, recoverStaleJobs } from "./queue.ts";

export type JobHandler = (job: Job) => Promise<void>;

export interface RunnerOptions {
  pollMs?: number;
  log?: (msg: string) => void;
}

/**
 * Two lanes: one light worker and one heavy worker. Heavy jobs (transcription, embedding
 * backfills) are serialized so whisper and Ollama don't fight for the CPU.
 */
export class JobRunner {
  private stopped = true;
  private readonly lanes: Promise<void>[] = [];
  private wake: (() => void) | undefined;
  private readonly db: Db;
  private readonly handlers: Record<string, JobHandler>;
  private readonly opts: RunnerOptions;

  constructor(db: Db, handlers: Record<string, JobHandler>, opts: RunnerOptions = {}) {
    this.db = db;
    this.handlers = handlers;
    this.opts = opts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    recoverStaleJobs(this.db);
    this.lanes.push(this.lane(false), this.lane(true));
  }

  /** Wakes idle lanes immediately, e.g. right after an enqueue. */
  poke(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.poke();
    await Promise.all(this.lanes.splice(0));
  }

  /** Runs every ready job once, sequentially. For tests and the offline CLI. */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const job = claimNext(this.db, { heavy: false }) ?? claimNext(this.db, { heavy: true });
      if (!job) return n;
      await this.run(job);
      n++;
    }
  }

  private async lane(heavy: boolean): Promise<void> {
    while (!this.stopped) {
      const job = claimNext(this.db, { heavy });
      if (job) {
        await this.run(job);
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs ?? 500);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    const view = jobView(job);
    const status = (state: AgentState, line?: string) => {
      if (!view) return;
      recordEvent(this.db, {
        kind: "status",
        runId: job.id,
        state,
        runKind: view.runKind,
        title: view.title,
        ...(line ? { line } : {}),
      });
    };
    status(view?.background ? "background" : "working");
    try {
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      await handler(job);
      completeJob(this.db, job.id);
      status("completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = failJob(this.db, job, msg);
      if (view) {
        recordEvent(this.db, {
          kind: "error",
          runId: job.id,
          code: "JOB_FAILED",
          message: msg.slice(0, 500),
          tried: `Attempt ${job.attempts + 1} of ${job.maxAttempts}.`,
          ...(outcome === "failed" ? { youCan: "Check the log, then run it again." } : {}),
        });
        if (outcome === "failed") status("failed");
        else status("waiting", "Retrying automatically.");
      }
      this.opts.log?.(`job ${job.type} ${job.id} ${outcome}: ${msg}`);
    }
  }
}

/** How a job shows up in the event stream, or null for jobs too small to show (embedding). */
function jobView(job: Job): { title: string; runKind: RunKind; background: boolean } | null {
  switch (job.type) {
    case "embed_document":
      return null;
    case "routine":
      return { title: "Routine", runKind: "routine", background: true };
    case "style_profile":
      return { title: "Learning your writing style", runKind: "job", background: true };
    case "transcribe_meeting":
      return { title: "Transcribing a recording", runKind: "job", background: false };
    case "understand_meeting":
      return { title: "Extracting decisions and commitments", runKind: "job", background: false };
    case "study":
      return { title: "Making study material", runKind: "job", background: false };
    default:
      return { title: job.type.replace(/_/g, " "), runKind: "job", background: false };
  }
}

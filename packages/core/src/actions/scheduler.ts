import type { ActionService } from "./service.ts";

/**
 * Runs approved actions once their Undo window has passed (docs/DECISIONS.md D-014). Execution
 * still goes through ActionService.execute, which re-checks the approved payload hash. One tick
 * at a time; an action that fails is recorded as failed and never retried automatically.
 */
export class ActionScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy: Promise<void> | null = null;
  private readonly actions: ActionService;
  private readonly intervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    actions: ActionService,
    opts: { intervalMs?: number; log?: (msg: string) => void } = {},
  ) {
    this.actions = actions;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.busy;
  }

  /** Runs every due action, one at a time. Overlapping calls share the running tick. */
  tick(now?: number): Promise<void> {
    if (this.busy) return this.busy;
    const run = (async () => {
      for (const id of this.actions.due(now)) {
        try {
          await this.actions.execute(id, { by: "schedule" });
        } catch (err) {
          // Revoked or claimed elsewhere between listing and running: nothing to do.
          this.log(`action ${id} not run: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    // Cleared in a later microtask: with nothing due the body above finishes synchronously.
    const busy = run.finally(() => {
      if (this.busy === busy) this.busy = null;
    });
    this.busy = busy;
    return busy;
  }
}

import type { AgentState, RockyEvent, RunKind } from "@rocky/contracts";

/**
 * A reducer over the typed event union (UI spec "State": "a reducer over a typed event union for
 * runs"). Pure: the same events always give the same runs, so a replay after a reconnect rebuilds
 * exactly what was on screen.
 */

export interface StepView {
  seq: number;
  at: number;
  state: AgentState;
  sentence: string;
  /** Planned steps are drawn as outlines until they happen. */
  planned: boolean;
  error?: { message: string; tried?: string; youCan?: string; code: string };
}

export interface RunView {
  id: string;
  kind: RunKind;
  title: string;
  state: AgentState;
  /** The one live line: what is happening now. */
  line: string | null;
  step: { n: number; of?: number } | null;
  startedAt: number;
  updatedAt: number;
  steps: StepView[];
  receipts: Extract<RockyEvent, { kind: "receipt" }>[];
  lastSeq: number;
}

const TERMINAL: AgentState[] = ["completed", "failed"];

export function receiptText(e: Extract<RockyEvent, { kind: "receipt" }>): string {
  return `${e.tool} → ${e.verb} ${e.count} ${e.unit}${e.count === 1 ? "" : e.unit.endsWith("s") ? "" : "s"}${e.notDone ? ` · ${e.notDone}` : ""}`;
}

export function foldRuns(
  events: RockyEvent[],
  into = new Map<string, RunView>(),
): Map<string, RunView> {
  for (const e of events) {
    if (!e.runId) continue;
    let run = into.get(e.runId);
    if (!run) {
      run = {
        id: e.runId,
        kind: e.kind === "approval" ? "action" : e.kind === "status" ? e.runKind : "job",
        title: e.kind === "status" ? e.title : e.kind === "approval" ? e.title : "Run",
        state: "thinking",
        line: null,
        step: null,
        startedAt: e.at,
        updatedAt: e.at,
        steps: [],
        receipts: [],
        lastSeq: 0,
      };
      into.set(e.runId, run);
    }
    if (e.seq <= run.lastSeq) continue; // a replay overlapping what we already have
    run.lastSeq = e.seq;
    run.updatedAt = e.at;
    switch (e.kind) {
      case "status":
        run.title = e.title;
        run.kind = e.runKind;
        run.state = e.state;
        run.line = e.line ?? (TERMINAL.includes(e.state) ? null : run.line);
        run.step = e.step ?? run.step;
        run.steps.push({
          seq: e.seq,
          at: e.at,
          state: e.state,
          sentence: e.line ?? e.title,
          planned: false,
        });
        break;
      case "receipt":
        run.receipts.push(e);
        run.steps.push({
          seq: e.seq,
          at: e.at,
          state: "completed",
          sentence: receiptText(e),
          planned: false,
        });
        break;
      case "approval": {
        run.kind = "action";
        run.title = e.title;
        const state: AgentState =
          e.change === "proposed" || e.change === "edited" || e.change === "revoked"
            ? "needs_approval"
            : e.change === "approved"
              ? "waiting"
              : e.change === "executed"
                ? "completed"
                : "failed";
        run.state = e.change === "rejected" || e.change === "blocked" ? "completed" : state;
        run.steps.push({
          seq: e.seq,
          at: e.at,
          state: run.state,
          sentence: `${e.change[0]?.toUpperCase()}${e.change.slice(1)}: ${e.title}`,
          // Approved but not run yet: intent, not completion.
          planned: e.change === "approved" || e.change === "proposed",
        });
        break;
      }
      case "error":
        run.state = "failed";
        run.line = null; // the live line described work that has stopped
        run.steps.push({
          seq: e.seq,
          at: e.at,
          state: "failed",
          sentence: e.message,
          planned: false,
          error: {
            message: e.message,
            code: e.code,
            ...(e.tried ? { tried: e.tried } : {}),
            ...(e.youCan ? { youCan: e.youCan } : {}),
          },
        });
        break;
      case "memory":
        run.steps.push({
          seq: e.seq,
          at: e.at,
          state: e.change === "used" ? "remembers" : "learned",
          sentence: e.text,
          planned: false,
        });
        break;
      case "message":
        break;
    }
  }
  return into;
}

/** Runs still in flight (not done, failed or resolved), newest first. */
export function activeRuns(runs: Map<string, RunView>): RunView[] {
  return [...runs.values()]
    .filter((r) => !TERMINAL.includes(r.state) && r.state !== "needs_approval")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Runs that finished since `since`, newest first. */
export function finishedSince(runs: Map<string, RunView>, since: number): RunView[] {
  return [...runs.values()]
    .filter((r) => TERMINAL.includes(r.state) && r.updatedAt >= since)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "4 min", "12 s", "1 h 5 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

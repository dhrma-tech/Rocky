import type { RockyEvent } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import { activeRuns, elapsed, finishedSince, foldRuns, receiptText } from "../src/agent-ui/runs.ts";

let seq = 0;
const at = (n: number) => 1_000 + n * 1000;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, at: at(seq), ...e }) as RockyEvent;

describe("foldRuns", () => {
  it("follows a sync from background to a receipt and done", () => {
    seq = 0;
    const events = [
      ev({
        kind: "status",
        runId: "s1",
        state: "background",
        runKind: "sync",
        title: "Syncing Gmail",
        line: "Reading Gmail",
      }),
      ev({
        kind: "receipt",
        runId: "s1",
        tool: "Gmail",
        verb: "synced",
        count: 12,
        unit: "items",
        notDone: "0 changed in Gmail",
      }),
      ev({
        kind: "status",
        runId: "s1",
        state: "completed",
        runKind: "sync",
        title: "Syncing Gmail",
      }),
    ];
    const run = foldRuns(events).get("s1");
    expect(run).toMatchObject({
      kind: "sync",
      state: "completed",
      title: "Syncing Gmail",
      line: null,
    });
    expect(run?.receipts).toHaveLength(1);
    expect(run?.steps.map((s) => s.state)).toEqual(["background", "completed", "completed"]);
    expect(receiptText(run?.receipts[0] as never)).toBe(
      "Gmail → synced 12 items · 0 changed in Gmail",
    );
  });

  it("keeps completed receipts when a run fails and opens the error with its three lines", () => {
    seq = 0;
    const runs = foldRuns([
      ev({ kind: "status", runId: "j", state: "working", runKind: "job", title: "Transcribing" }),
      ev({
        kind: "receipt",
        runId: "j",
        tool: "whisper",
        verb: "transcribed",
        count: 3,
        unit: "minutes",
      }),
      ev({
        kind: "error",
        runId: "j",
        code: "JOB_FAILED",
        message: "ffmpeg missing",
        tried: "Attempt 1 of 1.",
        youCan: "Run doctor.",
      }),
    ]);
    const run = runs.get("j");
    expect(run?.state).toBe("failed");
    expect(run?.line).toBeNull();
    expect(run?.receipts).toHaveLength(1);
    expect(run?.steps.at(-1)?.error).toEqual({
      message: "ffmpeg missing",
      code: "JOB_FAILED",
      tried: "Attempt 1 of 1.",
      youCan: "Run doctor.",
    });
  });

  it("an approval is needs-you until approved, planned while held, then done", () => {
    seq = 0;
    const base = {
      kind: "approval",
      runId: "a",
      actionId: "a",
      title: "Create issue",
      risk: "medium",
      review: "standard",
    };
    const runs = new Map();
    foldRuns([ev({ ...base, change: "proposed" })], runs);
    expect(runs.get("a").state).toBe("needs_approval");
    foldRuns([ev({ ...base, change: "approved" })], runs);
    expect(runs.get("a")).toMatchObject({ state: "waiting" });
    expect(runs.get("a").steps.at(-1).planned).toBe(true);
    foldRuns([ev({ ...base, change: "executed" })], runs);
    expect(runs.get("a").state).toBe("completed");
  });

  it("ignores replayed events it has already applied", () => {
    seq = 0;
    const one = ev({ kind: "status", runId: "r", state: "working", runKind: "job", title: "T" });
    const runs = foldRuns([one]);
    foldRuns([one], runs);
    expect(runs.get("r")?.steps).toHaveLength(1);
  });

  it("sorts active and finished runs", () => {
    seq = 0;
    const runs = foldRuns([
      ev({ kind: "status", runId: "a", state: "working", runKind: "job", title: "A" }),
      ev({ kind: "status", runId: "b", state: "completed", runKind: "job", title: "B" }),
      ev({ kind: "status", runId: "c", state: "background", runKind: "sync", title: "C" }),
    ]);
    expect(activeRuns(runs).map((r) => r.id)).toEqual(["c", "a"]);
    expect(finishedSince(runs, 0).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("elapsed", () => {
  it("reads like the spec's examples", () => {
    expect(elapsed(12_000)).toBe("12 s");
    expect(elapsed(4 * 60_000)).toBe("4 min");
    expect(elapsed(65 * 60_000)).toBe("1 h 5 min");
  });
});

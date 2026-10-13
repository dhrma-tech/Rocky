// UI spec 10: task history folds each run from its events; archive hides a run and Undo restores it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveRuns,
  createRoutine,
  type Db,
  JobRunner,
  listRuns,
  recordEvent,
  unarchiveRuns,
} from "../src/index.ts";
import { enqueue } from "../src/jobs/queue.ts";
import { memoryDb } from "./helpers.ts";

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

function ask(id: string, at: number, ok: boolean) {
  recordEvent(db, {
    kind: "status",
    runId: id,
    at,
    state: "thinking",
    runKind: "ask",
    title: `Ask: ${id}`,
  });
  if (ok) {
    recordEvent(db, {
      kind: "receipt",
      runId: id,
      at: at + 1000,
      tool: "Ask",
      verb: "cited",
      count: 3,
      unit: "source",
      notDone: "0 changed",
    });
    recordEvent(db, {
      kind: "status",
      runId: id,
      at: at + 2000,
      state: "completed",
      runKind: "ask",
      title: `Ask: ${id}`,
    });
  } else {
    recordEvent(db, {
      kind: "error",
      runId: id,
      at: at + 1000,
      code: "X",
      message: "Ollama is not running.",
    });
    recordEvent(db, {
      kind: "status",
      runId: id,
      at: at + 2000,
      state: "failed",
      runKind: "ask",
      title: `Ask: ${id}`,
    });
  }
}

describe("task history", () => {
  it("folds runs newest first with state, receipts and outcome", () => {
    ask("budget", 1_000, true);
    ask("exams", 5_000, false);
    recordEvent(db, {
      kind: "status",
      runId: null,
      at: 9_000,
      state: "completed",
      runKind: "job",
      title: "loose",
    });
    const runs = listRuns(db);
    expect(runs.map((r) => r.id)).toEqual(["exams", "budget"]);
    expect(runs[1]).toMatchObject({
      kind: "ask",
      title: "Ask: budget",
      state: "completed",
      startedAt: 1_000,
      updatedAt: 3_000,
      receipts: 1,
      outcome: "Ask → cited 3 sources · 0 changed",
      archived: false,
      routineId: null,
    });
    expect(runs[0]).toMatchObject({ state: "failed", outcome: "Ollama is not running." });
  });

  it("filters by status, date and words in the title or outcome", () => {
    ask("budget", 1_000, true);
    ask("exams", 5_000, false);
    expect(listRuns(db, { status: "failed" }).map((r) => r.id)).toEqual(["exams"]);
    expect(listRuns(db, { status: "done" }).map((r) => r.id)).toEqual(["budget"]);
    expect(listRuns(db, { from: 4_000 }).map((r) => r.id)).toEqual(["exams"]);
    expect(listRuns(db, { q: "OLLAMA" }).map((r) => r.id)).toEqual(["exams"]);
    expect(listRuns(db, { q: "cited 3" }).map((r) => r.id)).toEqual(["budget"]);
  });

  it("archive hides a run without touching its events; unarchive brings it back", () => {
    ask("budget", 1_000, true);
    const before = (db.prepare("select count(*) as n from events").get() as { n: number }).n;
    expect(archiveRuns(db, ["budget"])).toBe(1);
    expect(listRuns(db)).toEqual([]);
    expect(listRuns(db, { archived: "1" }).map((r) => [r.id, r.archived])).toEqual([
      ["budget", true],
    ]);
    expect((db.prepare("select count(*) as n from events").get() as { n: number }).n).toBe(before);
    expect(unarchiveRuns(db, ["budget"])).toBe(1);
    expect(listRuns(db).map((r) => r.id)).toEqual(["budget"]);
  });

  it("a routine's run carries its name and routine id so it can run again", async () => {
    const id = createRoutine(db, {
      name: "Monday brief",
      schedule: "0 8 * * 1",
      inputs: ["overdue"],
      prompt: "Brief me.",
    });
    const jobId = enqueue(db, "routine", { routineId: id, at: 1 }, { maxAttempts: 1 });
    const runner = new JobRunner(db, { routine: async () => {} }, { pollMs: 5 });
    runner.start();
    await expect.poll(() => listRuns(db)[0]?.state).toBe("completed");
    await runner.stop();
    expect(listRuns(db)[0]).toMatchObject({
      id: jobId,
      kind: "routine",
      title: "Routine: Monday brief",
      routineId: id,
    });
  });
});

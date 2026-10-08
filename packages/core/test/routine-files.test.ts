// Roadmap A6: routines kept as files (one folder each), read again on every tick; UI spec 11:
// three failures in a row pause a routine.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRoutine,
  type Db,
  eventsAfter,
  exportRoutine,
  getRoutine,
  listRoutines,
  parseRoutineFile,
  routinesDir,
  runRoutine,
  syncRoutineFiles,
  updateRoutine,
} from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { memoryDb, tempDir } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
let dir: string;
beforeEach(() => {
  db = memoryDb();
  dir = tempDir();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const FILE = `---
name: Monday plan
schedule: "0 8 * * 1"
inputs: [week_meetings, commitments_due_7d]
enabled: true
---
Plan my week from these meetings and commitments. Cite every point.
`;
const put = (slug: string, text: string) => {
  const d = path.join(routinesDir(dir), slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "ROUTINE.md"), text);
};

describe("routine files", () => {
  it("parse front matter and prompt, and refuse what isn't valid", () => {
    expect(parseRoutineFile(FILE)).toEqual({
      front: {
        name: "Monday plan",
        schedule: "0 8 * * 1",
        inputs: ["week_meetings", "commitments_due_7d"],
        enabled: true,
      },
      prompt: "Plan my week from these meetings and commitments. Cite every point.",
    });
    expect(() => parseRoutineFile("no front matter")).toThrow(/starts with a ---/);
    expect(() => parseRoutineFile(FILE.replace('"0 8 * * 1"', '"every monday"'))).toThrow(/cron/);
    expect(() => parseRoutineFile(FILE.replace("week_meetings", "all_my_email"))).toThrow();
    expect(() => parseRoutineFile(FILE.replace(/---\nPlan[\s\S]*$/, "---\n"))).toThrow(
      /needs a prompt/,
    );
  });

  it("sync adds, updates and removes routines from folders; a broken file is reported, not guessed", () => {
    put("monday-plan", FILE);
    put("broken", "---\nname: x\n---\nhi");
    const r = syncRoutineFiles(db, dir);
    expect(r.map((x) => [x.slug, x.ok])).toEqual([
      ["broken", false],
      ["monday-plan", true],
    ]);
    const [routine] = listRoutines(db, { dataDir: dir });
    expect(routine).toMatchObject({
      name: "Monday plan",
      enabled: true,
      edited: false,
      file: path.join(routinesDir(dir), "monday-plan", "ROUTINE.md"),
    });
    put("monday-plan", FILE.replace("Monday plan", "Week ahead"));
    syncRoutineFiles(db, dir);
    expect(listRoutines(db, { dataDir: dir }).map((x) => x.name)).toEqual(["Week ahead"]);
    fs.rmSync(path.join(routinesDir(dir), "monday-plan"), { recursive: true });
    syncRoutineFiles(db, dir);
    expect(listRoutines(db, { dataDir: dir })).toEqual([]);
  });

  it("a pause from the screen holds until the file itself changes; other edits go to the file", () => {
    put("monday-plan", FILE);
    syncRoutineFiles(db, dir);
    const id = listRoutines(db)[0]?.id as string;
    updateRoutine(db, id, { enabled: false });
    syncRoutineFiles(db, dir);
    expect(getRoutine(db, id).enabled).toBe(false);
    expect(() => updateRoutine(db, id, { name: "Renamed" })).toThrow(/Edit the file/);
  });

  it("any routine exports as a folder that syncs back as a file routine", () => {
    const id = createRoutine(db, {
      name: "Exam countdown",
      schedule: "0 7 * * *",
      inputs: ["deadlines_14d"],
      prompt: "List exams in the next two weeks.",
      enabled: false,
    });
    const file = exportRoutine(db, id, routinesDir(dir));
    expect(path.relative(routinesDir(dir), file)).toBe(path.join("exam-countdown", "ROUTINE.md"));
    syncRoutineFiles(db, dir);
    expect(
      listRoutines(db, { dataDir: dir })
        .filter((r) => r.file)
        .map((r) => r.prompt),
    ).toEqual(["List exams in the next two weeks."]);
  });
});

describe("auto-pause", () => {
  it("three failed runs in a row pause the routine and say why", async () => {
    const at = (h: number) => new Date(2026, 9, 7, h, 0).getTime();
    // A calendar item today, so the routine has evidence and must call the model, which fails.
    const { text, blocks } = markdownBlocks("# Standup\n\nDaily.");
    upsertDocument(db, {
      parsed: {
        title: "Standup",
        sourceType: "calendar",
        text,
        units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
      },
      externalId: "ev1",
      createdAt: at(1),
      meta: { start: new Date(at(10)).toISOString() },
    });
    const id = createRoutine(db, {
      name: "Brief",
      schedule: "0 7 * * *",
      inputs: ["calendar_today"],
      prompt: "Brief me.",
      enabled: true,
    });
    const h = harness(db, fakeProviders(() => "not json at all").fetch, { withKey: false });
    h.settings.localOnly = true;
    for (let i = 0; i < 2; i++) {
      expect((await runRoutine({ db, router: h.router }, id, at(7) + i)).status).toBe("failed");
      expect(getRoutine(db, id).enabled).toBe(true);
    }
    expect((await runRoutine({ db, router: h.router }, id, at(7) + 2)).status).toBe("failed");
    expect(getRoutine(db, id).enabled).toBe(false);
    expect(
      eventsAfter(db, 0).find((e) => e.kind === "error" && e.code === "ROUTINE_PAUSED"),
    ).toMatchObject({ message: "Brief failed 3 times in a row, so Rocky paused it." });
  });
});

import type { SourceType } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collect,
  createRoutine,
  dueRoutines,
  lastScheduled,
  listPacks,
  listRoutines,
  promptBody,
  queueDueRoutines,
  ROUTINE_JOB,
  renderPrompt,
  routineJobHandler,
  routineRuns,
  seedRoutines,
  updateRoutine,
} from "../src/assistant/routines.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { JobRunner } from "../src/jobs/runner.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
// Wednesday 7 October 2026, local time.
const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m).getTime();

function add(
  id: string,
  title: string,
  body: string,
  opts: { type?: SourceType; meta?: Record<string, unknown> } = {},
) {
  const { text, blocks } = markdownBlocks(body);
  return upsertDocument(db, {
    parsed: {
      title,
      sourceType: opts.type ?? "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: at(1),
    ...(opts.meta ? { meta: opts.meta } : {}),
  }).documentId;
}
const chunkOf = (docId: string) =>
  (
    db.prepare("select id from chunks where document_id = ? order by seq").get(docId) as {
      id: string;
    }
  ).id;
const isVerify = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("You check whether each claim");
const morning = () => {
  const r = listRoutines(db).find((x) => x.template === "morning-brief");
  if (!r) throw new Error("morning brief not seeded");
  return r;
};

beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("template packs", () => {
  it("ships three packs whose routines and prompts parse", () => {
    const packs = listPacks();
    expect(packs.map((p) => p.id)).toEqual(["founder-ops", "product-eng", "student"]);
    for (const p of packs) {
      expect(p.routines.length).toBeGreaterThanOrEqual(3);
      for (const r of p.routines) expect(lastScheduled(r.schedule, at(12))).not.toBeNull();
    }
  });

  it("strips frontmatter and fills {{date}}", () => {
    expect(promptBody("---\ntask: routine\n---\nHello {{date}}")).toBe("Hello {{date}}");
    expect(renderPrompt("Brief for {{date}} at {{time}} {{nope}}", at(7, 5))).toBe(
      "Brief for Wednesday 7 October 2026 at 07:05 {{nope}}",
    );
  });

  it("seeds the student pack once, switched off", () => {
    seedRoutines(db, { now: at(0) });
    seedRoutines(db, { now: at(0) });
    const all = listRoutines(db, { now: at(0) });
    expect(all.map((r) => r.template).sort()).toEqual([
      "deadline-digest",
      "end-of-day",
      "morning-brief",
    ]);
    expect(all.every((r) => !r.enabled && r.nextRunAt === null && r.prompt.length > 20)).toBe(true);
  });
});

describe("scheduling", () => {
  it("runs at the scheduled time, once; a machine asleep for days catches up once", () => {
    seedRoutines(db, { now: at(0) });
    const id = morning().id;
    updateRoutine(db, id, { enabled: true }, at(6)); // 0 7 * * 1-5
    expect(dueRoutines(db, at(6, 59))).toEqual([]);
    expect(queueDueRoutines(db, at(7, 1))).toEqual([id]);
    expect(queueDueRoutines(db, at(7, 2))).toEqual([]);
    // Asleep Thursday and Friday; woken Saturday noon → one run, not two.
    expect(queueDueRoutines(db, at(12, 0, 10))).toEqual([id]);
    expect(queueDueRoutines(db, at(12, 5, 10))).toEqual([]);
    expect(
      (
        db.prepare("select count(*) as n from jobs where type = ?").get(ROUTINE_JOB) as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });

  it("switching a routine on does not replay past times", () => {
    seedRoutines(db, { now: at(0, 0, 1) });
    updateRoutine(db, morning().id, { enabled: true }, at(12));
    expect(dueRoutines(db, at(12, 1))).toEqual([]);
  });

  it("rejects an invalid schedule", () => {
    expect(() =>
      createRoutine(db, { name: "x", schedule: "99 99 * * *", inputs: ["overdue"], prompt: "p" }),
    ).toThrow(/Invalid schedule/);
  });
});

describe("morning brief (acceptance #1)", () => {
  it("runs on schedule and stores cited sentences; unverifiable ones are dropped", async () => {
    const lecture = add(
      "ev1",
      "Linear algebra lecture",
      "# Linear algebra lecture\n\nRoom 204 with Dr. Rao.",
      {
        type: "calendar",
        meta: { start: new Date(at(10)).toISOString() },
      },
    );
    add("ev2", "Next week seminar", "# Seminar\n\nGuest talk.", {
      type: "calendar",
      meta: { start: new Date(at(10, 0, 14)).toISOString() },
    });
    const mail = add(
      "m1",
      "Lab report",
      "# Lab report\n\nI will submit the physics lab report by Monday.",
    );
    db.prepare(
      `insert into commitments (id, text, deadline, status, source_document_id, anchor, evidence_quote, created_at, updated_at)
       values ('c1', 'Submit the physics lab report', ?, 'open', ?, '{}', 'submit the physics lab report', 1, 1)`,
    ).run(at(9, 0, 5), mail);

    // calendar_today sees only today's event; overdue finds the commitment's evidence chunk.
    expect(collect(db, "calendar_today", at(7)).map((c) => c.documentId)).toEqual([lecture]);
    expect(collect(db, "overdue", at(7)).map((c) => c.documentId)).toEqual([mail]);

    seedRoutines(db, { now: at(0) });
    const id = morning().id;
    updateRoutine(db, id, { enabled: true }, at(6));
    const { fetch } = fakeProviders((_p, body) =>
      isVerify(body)
        ? {
            labels: [
              { i: 0, label: "SUPPORTED", reason: "ok" },
              { i: 1, label: "SUPPORTED", reason: "ok" },
            ],
          }
        : {
            sentences: [
              {
                text: "Linear algebra is in room 204 with Dr. Rao today.",
                citations: [chunkOf(lecture)],
                quote: "Room 204 with Dr. Rao",
              },
              {
                text: "The physics lab report is overdue.",
                citations: [chunkOf(mail)],
                quote: "I will submit the physics lab report by Monday",
              },
              { text: "Lunch is at noon.", citations: [chunkOf(mail)], quote: "lunch at noon" },
            ],
            notFound: false,
          },
    );
    const h = harness(db, fetch);
    expect(queueDueRoutines(db, at(7, 0))).toEqual([id]);
    await new JobRunner(db, { [ROUTINE_JOB]: routineJobHandler({ db, router: h.router }) }).drain();

    const [run] = routineRuns(db, id);
    expect(run).toMatchObject({ status: "done", notFound: false, error: null });
    expect(run?.answer.map((s) => s.text)).toEqual([
      "Linear algebra is in room 204 with Dr. Rao today.",
      "The physics lab report is overdue.",
    ]);
    expect(run?.answer.every((s) => s.citations.length > 0)).toBe(true);
    expect(morning().lastRun?.id).toBe(run?.id);
  });

  it("a failing model call is stored as a failed run with its reason", async () => {
    add("ev1", "Standup", "# Standup\n\nDaily.", {
      type: "calendar",
      meta: { start: new Date(at(10)).toISOString() },
    });
    seedRoutines(db, { now: at(0) });
    const id = morning().id;
    const h = harness(db, fakeProviders(() => "not json at all").fetch, { withKey: false });
    h.settings.localOnly = true;
    const { runRoutine } = await import("../src/assistant/routines.ts");
    const run = await runRoutine({ db, router: h.router }, id, at(7));
    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionRegistry } from "../src/actions/registry.ts";
import { ActionService } from "../src/actions/service.ts";
import { proposeFromDocument } from "../src/assistant/propose.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { registerTestTypes } from "./action-types.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
let registry: ActionRegistry;
let actions: ActionService;
const executed: unknown[] = [];

const STANDUP = [
  "# Standup 6 October",
  "",
  "Ana will fix the Safari login bug before Friday.",
  "",
  "Ravi will write the migration guide for the 2.0 release.",
  "",
  "Mei will add retry logic to the export job.",
].join("\n");

function addDoc(id: string, body: string) {
  const { text, blocks } = markdownBlocks(body);
  return upsertDocument(db, {
    parsed: {
      title: "Standup",
      sourceType: "transcript",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
  }).documentId;
}

const role = (body: Record<string, unknown>) => {
  const s = JSON.stringify(body);
  return s.includes("You decide which kinds of actions") ? "classify" : "propose";
};

beforeEach(() => {
  db = memoryDb();
  registry = new ActionRegistry();
  actions = new ActionService(db, registry);
  executed.length = 0;
  registerTestTypes(registry, executed);
});
afterEach(() => db.close());

const issue = (title: string, quote: string, ref = "c1") => ({
  type: "github.issueCreate",
  payload: { repo: "o/r", title },
  citations: [{ chunkRef: ref, quote }],
});

describe("proposals from a meeting (acceptance #3)", () => {
  it("N cited proposals; approve 2, reject 1; the audit log matches", async () => {
    const doc = addDoc("s1", STANDUP);
    const { fetch } = fakeProviders((_p, body) =>
      role(body) === "classify"
        ? { types: ["github.issueCreate"] }
        : {
            proposals: [
              issue("Fix Safari login bug", "Ana will fix the Safari login bug before Friday"),
              issue("Write 2.0 migration guide", "Ravi will write the migration guide"),
              issue("Add retry logic to export", "Mei will add retry logic to the export job"),
              issue("Uncited idea", "this text is not in the document"),
            ],
          },
    );
    const h = harness(db, fetch);
    const r = await proposeFromDocument(
      { db, router: h.router, actions, registry },
      { documentId: doc, instruction: "Make GitHub issues from today's standup" },
    );
    expect(r.proposed).toHaveLength(3);
    expect(r.proposed.every((p) => p.status === "draft" && p.citations.length === 1)).toBe(true);
    expect(r.proposed.every((p) => p.citations[0]?.documentId === doc)).toBe(true);
    expect(r.dropped).toEqual([
      { type: "github.issueCreate", reason: expect.stringMatching(/cite/i) },
    ]);
    expect(executed).toEqual([]);

    const [a, b, c] = r.proposed;
    if (!a || !b || !c) throw new Error("three proposals expected");
    actions.approve(a.id, a.payloadHash);
    actions.approve(b.id, b.payloadHash);
    actions.reject(c.id);
    await actions.execute(a.id);
    await actions.execute(b.id);
    expect(executed).toHaveLength(2);

    const audit = (id: string) =>
      (
        db
          .prepare("select event_type from audit_log where subject_id = ? order by seq")
          .all(id) as {
          event_type: string;
        }[]
      ).map((e) => e.event_type);
    expect(audit(a.id)).toEqual(["action_proposed", "action_approved", "action_executed"]);
    expect(audit(b.id)).toEqual(["action_proposed", "action_approved", "action_executed"]);
    expect(audit(c.id)).toEqual(["action_proposed", "action_rejected"]);
  });

  it("caps proposals at 10", async () => {
    const doc = addDoc("s1", STANDUP);
    const many = Array.from({ length: 12 }, (_, i) =>
      issue(`Task ${i}`, "Ana will fix the Safari login bug"),
    );
    const { fetch } = fakeProviders((_p, body) =>
      role(body) === "classify" ? { types: ["github.issueCreate"] } : { proposals: many },
    );
    const h = harness(db, fetch);
    const r = await proposeFromDocument(
      { db, router: h.router, actions, registry },
      { documentId: doc, instruction: "Make issues" },
    );
    expect(r.proposed).toHaveLength(10);
    expect(r.dropped).toHaveLength(2);
  });

  it("a request that asks for no action is refused before the document is read", async () => {
    const doc = addDoc("s1", STANDUP);
    const { fetch, calls } = fakeProviders(() => ({ types: [] }));
    const h = harness(db, fetch);
    await expect(
      proposeFromDocument(
        { db, router: h.router, actions, registry },
        { documentId: doc, instruction: "What happened?" },
      ),
    ).rejects.toMatchObject({ code: "NO_ACTION_TYPES" });
    expect(calls).toHaveLength(1);
  });
});

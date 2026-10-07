import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerOverChunks } from "../src/assistant/verified.ts";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { chunksById, documentChunks } from "../src/retrieval/retrieve.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, harness } from "./router-helpers.ts";

let db: Db;
let standup: string;
let budget: string;

function add(id: string, title: string, body: string, localOnly = false) {
  const { text, blocks } = markdownBlocks(body);
  const res = upsertDocument(db, {
    parsed: {
      title,
      sourceType: "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: 1_000,
  });
  if (localOnly) db.prepare("update documents set local_only = 1 where id = ?").run(res.documentId);
  return res.documentId;
}

const isVerify = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("You check whether each claim");

beforeEach(() => {
  db = memoryDb();
  standup = add(
    "standup",
    "Standup",
    "# Standup\n\nPriya will send the launch checklist by Thursday.",
  );
  budget = add("budget", "Budget", "# Budget\n\nThe Q4 marketing budget is $40,000.", true);
});
afterEach(() => db.close());

describe("direct chunk loading", () => {
  it("loads document chunks in order and chunks by id", () => {
    const chunks = documentChunks(db, [budget, standup, budget]);
    expect(chunks.map((c) => c.documentId)).toEqual([budget, standup]);
    expect(chunks[0]?.localOnly).toBe(true);
    const ids = chunks.map((c) => c.id);
    expect(chunksById(db, [ids[1] ?? "", "nope", ids[0] ?? ""]).map((c) => c.id)).toEqual([
      ids[1],
      ids[0],
    ]);
  });
});

describe("answerOverChunks", () => {
  it("keeps verified sentences, drops a bad quote, and cites the chunk", async () => {
    const chunks = documentChunks(db, [standup]);
    const id = chunks[0]?.id ?? "";
    const { fetch } = fakeProviders((_p, body) =>
      isVerify(body)
        ? { labels: [{ i: 0, label: "SUPPORTED", reason: "quoted" }] }
        : {
            sentences: [
              {
                text: "Priya owes the launch checklist by Thursday.",
                citations: [id],
                quote: "Priya will send the launch checklist by Thursday",
              },
              { text: "The launch moved to May.", citations: [id], quote: "launch moved to May" },
            ],
            notFound: false,
          },
    );
    const h = harness(db, fetch);
    const r = await answerOverChunks(
      { db, router: h.router },
      {
        task: "routine",
        origin: "routine:test",
        system: "You write a morning brief.",
        prompt: "Write today's brief.",
        chunks,
      },
    );
    expect(r.notFound).toBe(false);
    expect(r.answer).toHaveLength(1);
    expect(r.answer[0]?.citations[0]).toMatchObject({ chunkId: id, documentId: standup });
  });

  it("returns notFound with no chunks, without calling a model", async () => {
    const { fetch, calls } = fakeProviders(() => ({}));
    const h = harness(db, fetch);
    const r = await answerOverChunks(
      { db, router: h.router },
      { task: "routine", origin: "routine:test", system: "s", prompt: "p", chunks: [] },
    );
    expect(r).toMatchObject({ notFound: true, answer: [], path: null });
    expect(calls).toHaveLength(0);
  });

  it("keeps every call local when a chunk is local-only", async () => {
    const chunks = documentChunks(db, [budget]);
    const { fetch, calls } = fakeProviders(() => ({ sentences: [], notFound: true }));
    const h = harness(db, fetch);
    await answerOverChunks(
      { db, router: h.router },
      { task: "routine", origin: "routine:test", system: "s", prompt: "p", chunks },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.url.includes("anthropic"))).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.ts";
import { embedDocument } from "../src/ingest/embed-job.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { ftsQuery, searchFts } from "../src/retrieval/fts.ts";
import { isBroadQuestion, retrieve, rrf } from "../src/retrieval/retrieve.ts";
import { fakeEmbedder, memoryDb } from "./helpers.ts";

let db: Db;
const embedder = fakeEmbedder();

async function add(
  id: string,
  title: string,
  body: string,
  extra: { sourceType?: "markdown" | "email"; createdAt?: number } = {},
) {
  const { text, blocks } = markdownBlocks(body);
  const res = upsertDocument(db, {
    parsed: {
      title,
      sourceType: extra.sourceType ?? "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: extra.createdAt ?? 1_000,
  });
  await embedDocument(db, embedder, res.documentId);
  return res.documentId;
}

beforeEach(async () => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("rrf", () => {
  it("sums reciprocal ranks with k = 60", () => {
    const s = rrf([
      [1, 2],
      [2, 3],
    ]);
    expect(s.get(2)).toBeCloseTo(1 / 62 + 1 / 61);
    expect(s.get(1)).toBeCloseTo(1 / 61);
    expect([...s.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]).toBe(2);
  });
});

describe("ftsQuery", () => {
  it("quotes every term so FTS syntax in questions is inert", () => {
    expect(ftsQuery('title:secret OR NEAR("a" b) *')).toBe(
      '"title" OR "secret" OR "near" OR "title secret near"',
    );
    expect(ftsQuery("what is the")).toBeNull();
  });

  it("does not throw on hostile input", () => {
    expect(() => searchFts(db, 'x" OR 1=1 -- ^*', undefined)).not.toThrow();
  });
});

describe("retrieve", () => {
  it("finds lexical and semantic matches and respects scope", async () => {
    const a = await add(
      "a",
      "Pricing meeting",
      "We decided on tiered pricing for the enterprise plan.",
    );
    await add("b", "Hiring", "Two engineers will be hired in the first quarter.", {
      sourceType: "email",
      createdAt: 5_000,
    });
    const all = await retrieve(db, "What did we decide about pricing?", { embedder });
    expect(all[0]?.documentId).toBe(a);

    const emailsOnly = await retrieve(db, "pricing engineers", {
      embedder,
      scope: { sourceTypes: ["email"] },
    });
    expect(emailsOnly.every((c) => c.sourceType === "email")).toBe(true);
    const recent = await retrieve(db, "pricing engineers", {
      embedder,
      scope: { dateFrom: 2_000 },
    });
    expect(recent.map((c) => c.title)).toEqual(["Hiring"]);
    const notebook = await retrieve(db, "pricing", {
      embedder,
      scope: { notebookIds: ["nb-none"] },
    });
    expect(notebook).toEqual([]);
  });

  it("caps chunks per document and honours the token budget", async () => {
    const paras = Array.from(
      { length: 30 },
      (_, i) => `Pricing note ${i}: ${"tiered pricing discussion ".repeat(60)}`,
    ).join("\n\n");
    await add("long", "Long pricing doc", paras);
    const capped = await retrieve(db, "tiered pricing", { embedder });
    expect(capped.length).toBeLessThanOrEqual(3);
    const tight = await retrieve(db, "tiered pricing", { embedder, tokenBudget: 1 });
    expect(tight).toEqual([]);
  });

  it("returns anchors and the local-only flag", async () => {
    const id = await add("lo", "Private", "Private medical pricing notes.");
    db.prepare("update documents set local_only = 1 where id = ?").run(id);
    const [c] = await retrieve(db, "medical pricing", { embedder });
    expect(c?.anchor).toEqual({ kind: "text" });
    expect(c?.localOnly).toBe(true);
  });

  it("detects broad questions", () => {
    expect(isBroadQuestion("Summarize this course")).toBe(true);
    expect(isBroadQuestion("Who owns onboarding?")).toBe(false);
  });
});

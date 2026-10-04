import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.ts";
import { embedDocument } from "../src/ingest/embed-job.ts";
import { ingestPath } from "../src/ingest/ingest-file.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import type { ParsedDoc } from "../src/ingest/types.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { claimNext, enqueue, failJob, getJob, recoverStaleJobs } from "../src/jobs/queue.ts";
import { JobRunner } from "../src/jobs/runner.ts";
import { fakeEmbedder, fixture, memoryDb, tempDir } from "./helpers.ts";

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

const doc = (body: string): ParsedDoc => {
  const { text, blocks } = markdownBlocks(body);
  return {
    title: "Notes",
    sourceType: "markdown",
    text,
    units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
  };
};
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("upsertDocument", () => {
  it("creates, skips unchanged, and replaces chunks + index rows on change", async () => {
    const a = upsertDocument(db, {
      parsed: doc("# T\n\nAlpha pricing decision."),
      externalId: "x",
    });
    expect(a.status).toBe("created");
    await embedDocument(db, fakeEmbedder(), a.documentId);
    expect(count("select count(*) n from chunks_vec")).toBe(1);

    expect(
      upsertDocument(db, { parsed: doc("# T\n\nAlpha pricing decision."), externalId: "x" }).status,
    ).toBe("unchanged");

    const b = upsertDocument(db, {
      parsed: doc("# T\n\nBeta hiring plan.\n\nGamma roadmap."),
      externalId: "x",
    });
    expect(b).toMatchObject({ status: "updated", documentId: a.documentId });
    expect(count("select count(*) n from chunks_vec")).toBe(0);
    expect(
      db.prepare("select rowid from chunks_fts where chunks_fts match 'alpha'").all(),
    ).toHaveLength(0);
    expect(
      db.prepare("select rowid from chunks_fts where chunks_fts match 'hiring'").all(),
    ).toHaveLength(1);
    expect(count("select count(*) n from documents")).toBe(1);
  });

  it("indexes the title in FTS", () => {
    upsertDocument(db, {
      parsed: { ...doc("Body only."), title: "Quarterly Pricing" },
      externalId: "y",
    });
    expect(
      db.prepare("select rowid from chunks_fts where chunks_fts match 'title:quarterly'").all(),
    ).toHaveLength(1);
  });
});

describe("job queue", () => {
  it("claims by priority, backs off on failure, then fails permanently", () => {
    enqueue(db, "low", {}, { now: 1 });
    const hi = enqueue(db, "high", {}, { priority: 5, now: 2, maxAttempts: 2 });
    const job = claimNext(db, { heavy: false, now: 10 });
    expect(job?.id).toBe(hi);
    expect(failJob(db, job as NonNullable<typeof job>, "boom", 10)).toBe("queued");
    expect(getJob(db, hi)?.runAfter).toBe(10 + 5_000);
    expect(claimNext(db, { heavy: false, now: 11 })?.type).toBe("low");
    const again = claimNext(db, { heavy: false, now: 6_000 });
    expect(again?.id).toBe(hi);
    expect(failJob(db, again as NonNullable<typeof again>, "boom", 6_000)).toBe("failed");
  });

  it("keeps heavy and light lanes separate and recovers stale jobs", () => {
    enqueue(db, "transcribe", {}, { heavy: true, now: 1 });
    expect(claimNext(db, { heavy: false, now: 5 })).toBeUndefined();
    expect(claimNext(db, { heavy: true, now: 5 })?.type).toBe("transcribe");
    expect(recoverStaleJobs(db)).toBe(1);
  });
});

describe("ingestPath", () => {
  it("ingests supported fixtures, stores blobs and embeds via jobs", async () => {
    const results = await ingestPath(db, path.join(dir, "blobs"), path.dirname(fixture("x")));
    const created = results.filter((r) => r.status === "created");
    expect(created.length).toBeGreaterThanOrEqual(4);
    expect(results.some((r) => r.status === "skipped")).toBe(false);
    expect(fs.readdirSync(path.join(dir, "blobs")).length).toBeGreaterThan(0);

    const embedder = fakeEmbedder();
    const runner = new JobRunner(db, {
      embed_document: async (job) => {
        await embedDocument(db, embedder, (job.payload as { documentId: string }).documentId);
      },
    });
    await runner.drain();
    expect(count("select count(*) n from chunks_vec")).toBe(count("select count(*) n from chunks"));

    const again = await ingestPath(db, path.join(dir, "blobs"), path.dirname(fixture("x")));
    expect(again.every((r) => r.status === "unchanged" || r.status === "skipped")).toBe(true);
  });

  it("stores pdf page anchors on chunks", async () => {
    await ingestPath(db, path.join(dir, "blobs"), fixture("two-pages.pdf"));
    const rows = db.prepare("select anchor, text from chunks order by ord").all() as {
      anchor: string;
      text: string;
    }[];
    const page2 = rows.find((r) => r.text.includes("Rent control"));
    expect(JSON.parse(page2?.anchor ?? "{}")).toEqual({ kind: "pdf_page", page: 2 });
  });
});

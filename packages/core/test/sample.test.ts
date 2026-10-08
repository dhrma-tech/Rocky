// Roadmap A9: the sample loads apart from the user's sources, answers its tour, and leaves cleanly.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  loadSampleWorkspace,
  removeSampleWorkspace,
  SAMPLE_DIR,
  SAMPLE_TOUR,
  sampleLoaded,
  suggestedQuestions,
} from "../src/index.ts";
import { ingestFile } from "../src/ingest/ingest-file.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let blobs: string;
beforeEach(() => {
  db = memoryDb();
  blobs = tempDir();
});
afterEach(() => {
  db.close();
  fs.rmSync(blobs, { recursive: true, force: true });
});

describe("sample workspace", () => {
  it("loads five fictional documents under its own connector, tagged as sample", async () => {
    expect(await loadSampleWorkspace(db, blobs)).toEqual({ documents: 5 });
    expect(sampleLoaded(db)).toBe(true);
    const rows = db.prepare("select connector_id, meta from documents").all() as {
      connector_id: string;
      meta: string;
    }[];
    expect(
      rows.every((r) => r.connector_id === "sample" && JSON.parse(r.meta).sample === true),
    ).toBe(true);
    // Loading twice changes nothing.
    await loadSampleWorkspace(db, blobs);
    expect((db.prepare("select count(*) as n from documents").get() as { n: number }).n).toBe(5);
  });

  it("holds the facts the tour asks about, and not the one it should not find", async () => {
    await loadSampleWorkspace(db, blobs);
    const all = (db.prepare("select raw_text from documents").all() as { raw_text: string }[])
      .map((r) => r.raw_text)
      .join("\n");
    expect(all).toContain("18 EUR for two bags");
    expect(all).toContain("Monday 13 October");
    expect(all).toContain("6.85 EUR");
    expect(all.toLowerCase()).not.toContain("japan");
    expect(SAMPLE_TOUR.at(-1)?.expect).toMatch(/^Not found/);
  });

  it("suggests the tour until real data exists, then questions from it; removal leaves real data", async () => {
    expect(suggestedQuestions(db)).toEqual([]);
    await loadSampleWorkspace(db, blobs);
    expect(suggestedQuestions(db)).toEqual(SAMPLE_TOUR.slice(0, 3).map((t) => t.question));
    const own = path.join(tempDir(), "Quarterly plan.md");
    fs.writeFileSync(own, "# Quarterly plan\n\nShip the beta in November.");
    await ingestFile(db, blobs, own);
    expect(suggestedQuestions(db)).toEqual(['What are the key points of "Quarterly plan"?']);
    expect(removeSampleWorkspace(db, blobs)).toEqual({ documents: 5 });
    expect((db.prepare("select count(*) as n from documents").get() as { n: number }).n).toBe(1);
    expect(sampleLoaded(db)).toBe(false);
  });

  it("ships no README as a document", () => {
    expect(fs.readdirSync(SAMPLE_DIR)).toContain("README.md");
  });
});

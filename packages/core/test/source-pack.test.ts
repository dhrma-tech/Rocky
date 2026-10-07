import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/index.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../src/ingest/upsert.ts";
import { isoWeek, sourcePack } from "../src/notebooks/export.ts";
import { createNotebook } from "../src/notebooks/service.ts";
import { memoryDb } from "./helpers.ts";

let db: Db;
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

function add(id: string, title: string, body: string, createdAt: number) {
  const { text, blocks } = markdownBlocks(body);
  return upsertDocument(db, {
    parsed: {
      title,
      sourceType: "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt,
  }).documentId;
}

beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

describe("ISO week", () => {
  it("numbers weeks per ISO 8601, including year edges", () => {
    expect(isoWeek(day(2026, 1, 1)).week).toBe("2026-W01"); // a Thursday
    expect(isoWeek(day(2024, 12, 30)).week).toBe("2025-W01"); // Monday of week 1 of 2025
    expect(isoWeek(day(2027, 1, 1)).week).toBe("2026-W53"); // 2026 has 53 weeks
    const w = isoWeek(day(2026, 10, 7));
    expect(w.week).toBe("2026-W41");
    expect(new Date(w.start).getDay()).toBe(1);
    expect(w.end - w.start).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
  });
});

describe("Drive source pack", () => {
  it("packs only this week's sources, escapes their text and cites each one", () => {
    const inWeek = add(
      "l1",
      "Lecture 5 <b>",
      "# Lecture 5\n\nHeaps keep the <script>alert(1)</script> minimum at the root.",
      day(2026, 10, 6),
    );
    const old = add("l0", "Lecture 1", "# Lecture 1\n\nArrays.", day(2026, 9, 1));
    const nb = createNotebook(db, {
      name: "CS201",
      scope: { documentIds: [inWeek, old], excludedIds: [], rules: {} },
    });
    const pack = sourcePack(db, nb.id, day(2026, 10, 7));
    expect(pack.documents).toBe(1);
    expect(pack.payload).toMatchObject({
      course: "CS201",
      week: "2026-W41",
      title: "CS201: 2026-W41",
    });
    expect(pack.payload.html).toContain("Lecture 5 &lt;b&gt;");
    expect(pack.payload.html).toContain("&lt;script&gt;");
    expect(pack.payload.html).not.toContain("<script>");
    expect(pack.payload.html).not.toContain("Arrays.");
    expect(pack.citations).toHaveLength(1);
    expect(pack.citations[0]?.documentId).toBe(inWeek);
  });
});

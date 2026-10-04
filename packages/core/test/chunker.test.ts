import { describe, expect, it } from "vitest";
import { chunkDocument, chunkTokens } from "../src/ingest/chunker.ts";
import { markdownBlocks } from "../src/ingest/parsers/text-blocks.ts";
import type { ParsedDoc, Unit } from "../src/ingest/types.ts";

const sentence = (i: number) =>
  `Sentence number ${i} talks about supply, demand and prices in some detail.`;
const para = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => sentence(from + i)).join(" ");

function mdDoc(md: string): ParsedDoc {
  const { text, blocks } = markdownBlocks(md);
  return {
    title: "t",
    sourceType: "markdown",
    text,
    units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
  };
}

function pagedDoc(pages: string[]): ParsedDoc {
  let text = "";
  const units: Unit[] = [];
  pages.forEach((p, i) => {
    if (text) text += "\n\n";
    const start = text.length;
    text += p;
    units.push({
      anchor: { kind: "pdf_page", page: i + 1 },
      start,
      end: text.length,
      blocks: [{ type: "para", start, end: text.length }],
    });
  });
  return { title: "t", sourceType: "pdf", text, units };
}

describe("chunkDocument", () => {
  it("keeps chunk text equal to the raw_text slice", () => {
    const doc = mdDoc(`# A\n\n${para(0, 30)}\n\n${para(30, 30)}\n\n## B\n\n${para(60, 10)}`);
    for (const c of chunkDocument(doc)) expect(doc.text.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  it("never crosses an anchor unit", () => {
    const doc = pagedDoc([para(0, 5), para(5, 5), para(10, 5)]);
    const chunks = chunkDocument(doc);
    expect(chunks.map((c) => c.anchor)).toEqual(
      [1, 2, 3].map((page) => ({ kind: "pdf_page", page })),
    );
    for (const c of chunks) {
      const unit = doc.units.find(
        (u) =>
          u.anchor.kind === "pdf_page" &&
          c.anchor.kind === "pdf_page" &&
          u.anchor.page === c.anchor.page,
      );
      expect(c.charStart).toBeGreaterThanOrEqual(unit?.start ?? -1);
      expect(c.charEnd).toBeLessThanOrEqual(unit?.end ?? -1);
    }
  });

  it("respects the hard cap even for one giant paragraph", () => {
    const doc = mdDoc(para(0, 400));
    const chunks = chunkDocument(doc, { targetTokens: 350, hardCapTokens: 900 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(900);
  });

  it("packs paragraphs near the target and overlaps neighbours", () => {
    const paras = Array.from({ length: 12 }, (_, i) => para(i * 4, 4)).join("\n\n");
    const chunks = chunkDocument(mdDoc(paras), { targetTokens: 200, overlap: 0.4 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(0, -1)) expect(c.tokenCount).toBeLessThanOrEqual(260);
    const [a, b] = chunks;
    expect(a && b && b.charStart < a.charEnd).toBe(true);
  });

  it("starts a new chunk at headings and records the section path", () => {
    const doc = mdDoc(`# Course\n\n## Week 1\n\n${para(0, 3)}\n\n## Week 2\n\n${para(3, 3)}`);
    const chunks = chunkDocument(doc);
    expect(chunks.map((c) => c.sectionPath)).toEqual(["Course > Week 1", "Course > Week 2"]);
    expect(chunks[1]?.text.startsWith("Week 2")).toBe(true);
  });

  it("estimates tokens at ~4 chars each", () => {
    expect(chunkTokens("abcd".repeat(10))).toBe(10);
  });
});

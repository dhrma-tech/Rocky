import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parserFor } from "../src/ingest/parsers/index.ts";
import type { ParsedDoc } from "../src/ingest/types.ts";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);
async function parse(name: string): Promise<ParsedDoc> {
  const parser = parserFor(name);
  if (!parser) throw new Error(`no parser for ${name}`);
  return parser.parse({ bytes: fs.readFileSync(fixture(name)), filename: name });
}

/** Every block and unit range must index into text, in order and without overlap. */
function expectConsistent(doc: ParsedDoc) {
  let last = -1;
  for (const u of doc.units) {
    expect(u.start).toBeGreaterThan(last);
    expect(u.end).toBeLessThanOrEqual(doc.text.length);
    for (const b of u.blocks) {
      expect(b.start).toBeGreaterThanOrEqual(u.start);
      expect(b.end).toBeLessThanOrEqual(u.end);
      expect(doc.text.slice(b.start, b.end).trim()).not.toBe("");
    }
    last = u.end;
  }
}

describe("parsers", () => {
  it("picks the longest matching extension", () => {
    expect(parserFor("a.transcript.txt")?.extensions).toContain(".transcript.txt");
    expect(parserFor("a.txt")?.extensions).toContain(".txt");
    expect(parserFor("a.exe")).toBeUndefined();
  });

  it("parses a PDF into one unit per page with page anchors", async () => {
    const doc = await parse("two-pages.pdf");
    expect(doc.units.map((u) => u.anchor)).toEqual([
      { kind: "pdf_page", page: 1 },
      { kind: "pdf_page", page: 2 },
    ]);
    const page2 = doc.text.slice(doc.units[1]?.start, doc.units[1]?.end);
    expect(page2).toContain("Rent control is a common example of a price ceiling");
    expect(doc.text.slice(doc.units[0]?.start, doc.units[0]?.end)).not.toContain("Rent control");
    expect(doc.units[1]?.blocks.some((b) => b.type === "heading")).toBe(true);
    expectConsistent(doc);
  });

  it("parses DOCX headings and paragraphs", async () => {
    const doc = await parse("kickoff.docx");
    expect(doc.title).toBe("Project Kickoff");
    expect(doc.text).toContain("We agreed to ship the beta on March 3.");
    expectConsistent(doc);
  });

  it("parses bracketed transcripts into ≤60 s windows", async () => {
    const doc = await parse("standup.transcript.txt");
    expect(doc.units.map((u) => u.anchor)).toEqual([
      { kind: "transcript", startMs: 5_000, endMs: 58_000 },
      { kind: "transcript", startMs: 58_000, endMs: 90_000 },
    ]);
    expect(doc.text).toContain("Sam: I will send the revised deck by Friday.");
    expectConsistent(doc);
  });

  it("parses WebVTT with voice tags", async () => {
    const doc = await parse("lecture.vtt");
    expect(doc.text).toContain("Prof. Lee: Rent control is the classic example.");
    expect(doc.units[0]?.anchor).toEqual({ kind: "transcript", startMs: 1_000, endMs: 9_000 });
  });

  it("parses HTML, skipping scripts and nav", async () => {
    const html =
      "<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><h1>Head</h1><p>Body <b>text</b>.</p></body></html>";
    const doc = await parserFor("x.html")?.parse({
      bytes: new TextEncoder().encode(html),
      filename: "x.html",
    });
    expect(doc?.text).toBe("Head\n\nBody text.");
    expect(doc?.title).toBe("T");
  });

  it("parses markdown and strips front matter", async () => {
    const md = "---\ntags: [a]\n---\n# Title\n\nPara one\nline two.\n\n## Sub\n\nPara two.";
    const doc = await parserFor("x.md")?.parse({
      bytes: new TextEncoder().encode(md),
      filename: "x.md",
    });
    expect(doc?.title).toBe("Title");
    expect(doc?.units[0]?.blocks.map((b) => b.type)).toEqual([
      "heading",
      "para",
      "heading",
      "para",
    ]);
  });
});

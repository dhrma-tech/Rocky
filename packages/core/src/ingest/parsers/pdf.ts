import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Block, Parser, Unit } from "../types.ts";

interface Line {
  text: string;
  height: number;
  y: number;
}

interface TextItemLike {
  str: string;
  hasEOL: boolean;
  transform: number[];
  height: number;
}

/** Groups pdf.js text items into visual lines (items share a baseline until hasEOL). */
function toLines(items: TextItemLike[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of items) {
    const y = it.transform[5] ?? 0;
    const h = Math.abs(it.transform[3] ?? it.height);
    if (!cur) cur = { text: "", height: h, y };
    cur.text += it.str;
    cur.height = Math.max(cur.height, h);
    if (it.hasEOL) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines.filter((l) => l.text.trim());
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export const pdfParser: Parser = {
  extensions: [".pdf"],
  async parse({ bytes, filename }) {
    // pdf.js may detach the buffer it is given, so pass a copy.
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
    const doc = await task.promise;
    let text = "";
    const units: Unit[] = [];
    let firstHeading: string | undefined;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const lines = toLines(
          content.items.filter((i): i is TextItemLike & typeof i => "str" in i) as TextItemLike[],
        );
        const body = median(lines.map((l) => l.height)) || 1;
        if (text) text += "\n\n";
        const pageStart = text.length;
        const blocks: Block[] = [];
        let para: Line[] = [];
        const flush = () => {
          if (!para.length) return;
          if (text.length > pageStart) text += "\n\n";
          const start = text.length;
          text += para.map((l) => l.text.trim()).join("\n");
          blocks.push({ type: "para", start, end: text.length });
          para = [];
        };
        let prev: Line | undefined;
        for (const line of lines) {
          const isHeading = line.height > body * 1.25 && line.text.trim().length < 120;
          const gap = prev ? Math.abs(prev.y - line.y) : 0;
          if (isHeading) {
            flush();
            if (text.length > pageStart) text += "\n\n";
            const start = text.length;
            text += line.text.trim();
            blocks.push({
              type: "heading",
              level: line.height > body * 1.6 ? 1 : 2,
              start,
              end: text.length,
            });
            firstHeading ??= line.text.trim();
          } else {
            if (prev && gap > prev.height * 1.8) flush();
            para.push(line);
          }
          prev = line;
        }
        flush();
        units.push({
          anchor: { kind: "pdf_page", page: p },
          start: pageStart,
          end: text.length,
          blocks,
        });
        page.cleanup();
      }
      const info = (await doc.getMetadata().catch(() => null))?.info as
        | { Title?: string }
        | undefined;
      return {
        title: info?.Title?.trim() || firstHeading || path.parse(filename).name,
        sourceType: "pdf",
        text,
        units,
        meta: { pages: doc.numPages },
      };
    } finally {
      await task.destroy();
    }
  },
};

import type { Block } from "../types.ts";

/** Builds a document string piece by piece while tracking each piece's char range. */
export class TextBuilder {
  text = "";
  blocks: Block[] = [];

  /** Appends a block separated from the previous one by a blank line. Empty text is skipped. */
  add(type: Block["type"], raw: string, level?: number): void {
    const t = raw
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
    if (!t) return;
    if (this.text) this.text += "\n\n";
    const start = this.text.length;
    this.text += t;
    this.blocks.push(
      level === undefined
        ? { type, start, end: this.text.length }
        : { type, level, start, end: this.text.length },
    );
  }
}

/** Splits markdown-ish plain text into heading and paragraph blocks by blank lines and `#` lines. */
export function markdownBlocks(src: string): { text: string; blocks: Block[] } {
  const b = new TextBuilder();
  let para: string[] = [];
  const flush = () => {
    if (para.length) b.add("para", para.join("\n"));
    para = [];
  };
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      b.add("heading", h[2] ?? "", h[1]?.length);
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return { text: b.text, blocks: b.blocks };
}

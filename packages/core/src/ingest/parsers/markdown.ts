import path from "node:path";
import type { Parser } from "../types.ts";
import { markdownBlocks } from "./text-blocks.ts";

const decoder = new TextDecoder("utf-8");

function firstHeading(text: string, blocks: { type: string; start: number; end: number }[]) {
  const h = blocks.find((b) => b.type === "heading");
  return h ? text.slice(h.start, h.end) : undefined;
}

export const markdownParser: Parser = {
  extensions: [".md", ".markdown"],
  async parse({ bytes, filename }) {
    // Strip YAML front matter; it is metadata, not content.
    const src = decoder.decode(bytes).replace(/^---\n[\s\S]*?\n---\n/, "");
    const { text, blocks } = markdownBlocks(src);
    return {
      title: firstHeading(text, blocks) ?? path.parse(filename).name,
      sourceType: "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    };
  },
};

export const textParser: Parser = {
  extensions: [".txt"],
  async parse({ bytes, filename }) {
    const { text, blocks } = markdownBlocks(decoder.decode(bytes));
    return {
      title: path.parse(filename).name,
      sourceType: "text",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    };
  },
};

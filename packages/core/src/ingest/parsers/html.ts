import path from "node:path";
import { type HTMLElement, parse } from "node-html-parser";
import type { Parser } from "../types.ts";
import { TextBuilder } from "./text-blocks.ts";

const BLOCK_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "pre",
  "td",
  "th",
  "dd",
  "dt",
  "figcaption",
  "caption",
]);
const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "svg",
  "template",
]);

/** Walks the DOM in order, emitting headings and block-level text. Used for HTML and DOCX. */
export function htmlToBlocks(html: string): TextBuilder {
  const root = parse(html, { blockTextElements: { script: false, style: false, pre: true } });
  const b = new TextBuilder();
  const walk = (el: HTMLElement) => {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const node = child as HTMLElement;
      const tag = node.rawTagName?.toLowerCase() ?? "";
      if (SKIP_TAGS.has(tag)) continue;
      const h = /^h([1-6])$/.exec(tag);
      if (h) b.add("heading", node.text, Number(h[1]));
      else if (BLOCK_TAGS.has(tag)) b.add("para", node.text);
      else walk(node);
    }
  };
  walk(root);
  // Pages without block tags: fall back to the whole text as one paragraph.
  if (!b.text) b.add("para", root.text);
  return b;
}

export const htmlParser: Parser = {
  extensions: [".html", ".htm"],
  async parse({ bytes, filename }) {
    const html = new TextDecoder("utf-8").decode(bytes);
    const b = htmlToBlocks(html);
    const title = parse(html).querySelector("title")?.text.trim();
    return {
      title: title || path.parse(filename).name,
      sourceType: "html",
      text: b.text,
      units: [{ anchor: { kind: "text" }, start: 0, end: b.text.length, blocks: b.blocks }],
    };
  },
};

import path from "node:path";
import mammoth from "mammoth";
import type { Parser } from "../types.ts";
import { htmlToBlocks } from "./html.ts";

export const docxParser: Parser = {
  extensions: [".docx"],
  async parse({ bytes, filename }) {
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    const b = htmlToBlocks(html);
    const h1 = b.blocks.find((x) => x.type === "heading");
    return {
      title: h1 ? b.text.slice(h1.start, h1.end) : path.parse(filename).name,
      sourceType: "docx",
      text: b.text,
      units: [{ anchor: { kind: "text" }, start: 0, end: b.text.length, blocks: b.blocks }],
    };
  },
};

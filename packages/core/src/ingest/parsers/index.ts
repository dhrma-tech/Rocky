import type { Parser } from "../types.ts";
import { docxParser } from "./docx.ts";
import { htmlParser } from "./html.ts";
import { markdownParser, textParser } from "./markdown.ts";
import { pdfParser } from "./pdf.ts";
import { transcriptParser } from "./transcript.ts";

// Order matters: the longest extension wins (".transcript.txt" before ".txt").
const PARSERS: Parser[] = [
  transcriptParser,
  pdfParser,
  docxParser,
  htmlParser,
  markdownParser,
  textParser,
];

export function parserFor(filename: string): Parser | undefined {
  const lower = filename.toLowerCase();
  let best: { parser: Parser; len: number } | undefined;
  for (const parser of PARSERS) {
    for (const ext of parser.extensions) {
      if (lower.endsWith(ext) && ext.length > (best?.len ?? 0)) best = { parser, len: ext.length };
    }
  }
  return best?.parser;
}

export const supportedExtensions = PARSERS.flatMap((p) => p.extensions);

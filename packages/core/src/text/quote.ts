import { normalizeForQuote } from "../assistant/verified.ts";

/** Evidence quotes may be longer than answer quotes (40 words): a commitment can span a sentence or two. */
export const MAX_EVIDENCE_WORDS = 60;

/** Trims the punctuation a model tends to add or drop at the edges of a quote. */
const trimEdges = (s: string) => s.replace(/^[\s"'.,;:!?…-]+|[\s"'.,;:!?…-]+$/gu, "");

/** True when `quote` is non-trivial, at most MAX_EVIDENCE_WORDS long, and occurs verbatim in `text`. */
export function quoteInText(quote: string, text: string): boolean {
  const q = trimEdges(normalizeForQuote(quote));
  if (q.length < 3 || q.split(" ").length > MAX_EVIDENCE_WORDS) return false;
  return normalizeForQuote(text).includes(q);
}

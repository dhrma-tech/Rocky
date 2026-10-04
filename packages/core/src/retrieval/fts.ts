import type { Scope } from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { scopeFilter } from "./scope.ts";

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from had has have how i in is it its me my of on or our so that the their them then there these they this to us was we were what when where which who why will with you your about into than".split(
    " ",
  ),
);

/**
 * Builds a safe FTS5 MATCH expression from free text. Every term is double-quoted, so FTS
 * syntax in the user's question (NEAR, *, ^, column filters, quotes) is treated as text.
 * Terms are OR-ed; a phrase of the content words is added as a boost.
 */
export function ftsQuery(question: string): string | null {
  const words = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 1 && !STOPWORDS.has(w),
  );
  const unique = [...new Set(words)].slice(0, 24);
  if (unique.length === 0) return null;
  const terms = unique.map((w) => `"${w}"`);
  if (words.length >= 2) terms.push(`"${words.slice(0, 8).join(" ")}"`);
  return terms.join(" OR ");
}

/** Top-k chunk seqs by bm25 (text weighted over title), filtered by scope. */
export function searchFts(db: Db, question: string, scope: Scope | undefined, k = 50): number[] {
  const match = ftsQuery(question);
  if (!match) return [];
  const f = scopeFilter(scope);
  const rows = db
    .prepare(
      `select c.seq from chunks_fts
       join chunks c on c.seq = chunks_fts.rowid
       join documents d on d.id = c.document_id
       where chunks_fts match ? ${f.where ? `and ${f.where}` : ""}
       order by bm25(chunks_fts, 1.0, 0.3) limit ?`,
    )
    .all(match, ...f.params, k) as { seq: number }[];
  return rows.map((r) => r.seq);
}

import { type Anchor, AnchorSchema, type Scope, type SourceType } from "@rocky/contracts";
import type { Embedder } from "../router/embed.ts";
import type { Db } from "../store/db.ts";
import { searchFts } from "./fts.ts";
import { isNarrow } from "./scope.ts";
import { searchVec } from "./vec.ts";

export interface RetrievedChunk {
  seq: number;
  id: string;
  documentId: string;
  title: string;
  text: string;
  anchor: Anchor;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  sourceType: SourceType;
  sectionPath: string | null;
  /** Instruction-like content was detected at ingest (Phase 2 flagger). Down-weighted, never trusted. */
  suspicious: boolean;
  /** The document is marked local-only, so any model call that sees this chunk must stay local. */
  localOnly: boolean;
  score: number;
}

/** Reranker extension point (ARCHITECTURE.md). V1 ships the identity. */
export interface Reranker {
  rerank(query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]>;
}
export const noopReranker: Reranker = { rerank: async (_q, chunks) => chunks };

/** Reciprocal rank fusion: score(d) = Σ 1 / (k + rank_i(d)), ranks starting at 1. */
export function rrf(lists: number[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const [i, seq] of list.entries())
      scores.set(seq, (scores.get(seq) ?? 0) + 1 / (k + i + 1));
  }
  return scores;
}

const BROAD =
  /\b(summari[sz]e|overview|everything about|what did we cover|recap|main (points|topics))\b/i;
export const isBroadQuestion = (q: string) => BROAD.test(q);

export interface RetrieveOptions {
  scope?: Scope;
  embedder?: Embedder;
  reranker?: Reranker;
  /** Context token budget: 4000 for API models, 2500 for local (memory.md). */
  tokenBudget?: number;
  maxPerDocument?: number;
  fused?: number;
}

interface ChunkRow {
  seq: number;
  id: string;
  document_id: string;
  title: string;
  text: string;
  anchor: string;
  char_start: number;
  char_end: number;
  token_count: number;
  source_type: SourceType;
  section_path: string | null;
  suspicious: number;
  local_only: number;
}

function loadChunks(db: Db, seqs: number[]): Map<number, ChunkRow> {
  if (seqs.length === 0) return new Map();
  const rows = db
    .prepare(
      `select c.seq, c.id, c.document_id, d.title, c.text, c.anchor, c.char_start, c.char_end, c.token_count,
              d.source_type, c.section_path, d.suspicious, d.local_only
       from chunks c join documents d on d.id = c.document_id
       where c.seq in (${seqs.map(() => "?").join(",")})`,
    )
    .all(...seqs) as ChunkRow[];
  return new Map(rows.map((r) => [r.seq, r]));
}

/**
 * Hybrid retrieval (memory.md): FTS5 top 50 + vector KNN (50, or 200 for narrow scopes),
 * RRF-fused to the top 20, reranked (no-op), then greedily selected under a token budget
 * with at most 3 chunks per document (unless the scope is a single document).
 */
export async function retrieve(
  db: Db,
  question: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const scope = opts.scope;
  const ftsSeqs = searchFts(db, question, scope, 50);
  let vecSeqs: number[] = [];
  if (opts.embedder) {
    const [q] = await opts.embedder.embed([question], "query");
    if (q) vecSeqs = searchVec(db, q, scope, isNarrow(scope) ? 200 : 50);
  }
  const scores = rrf([ftsSeqs, vecSeqs]);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.fused ?? 20);
  const rows = loadChunks(
    db,
    ranked.map(([seq]) => seq),
  );

  let chunks: RetrievedChunk[] = [];
  for (const [seq, score] of ranked) {
    const r = rows.get(seq);
    if (!r) continue;
    chunks.push({
      seq,
      id: r.id,
      documentId: r.document_id,
      title: r.title,
      text: r.text,
      anchor: AnchorSchema.parse(JSON.parse(r.anchor)),
      charStart: r.char_start,
      charEnd: r.char_end,
      tokenCount: r.token_count,
      sourceType: r.source_type,
      sectionPath: r.section_path,
      suspicious: r.suspicious === 1,
      localOnly: r.local_only === 1,
      // Suspicious chunks are down-weighted (SECURITY.md); structural guards do the real work.
      score: r.suspicious === 1 ? score * 0.5 : score,
    });
  }
  chunks.sort((a, b) => b.score - a.score);
  chunks = await (opts.reranker ?? noopReranker).rerank(question, chunks);

  const singleDoc = scope?.documentIds?.length === 1;
  const maxPerDoc = singleDoc ? Number.POSITIVE_INFINITY : (opts.maxPerDocument ?? 3);
  const budget = opts.tokenBudget ?? 4000;
  const perDoc = new Map<string, number>();
  const selected: RetrievedChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const n = perDoc.get(c.documentId) ?? 0;
    if (n >= maxPerDoc || used + c.tokenCount > budget) continue;
    selected.push(c);
    perDoc.set(c.documentId, n + 1);
    used += c.tokenCount;
  }
  return selected;
}

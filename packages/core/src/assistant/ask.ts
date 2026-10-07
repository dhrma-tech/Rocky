import type { AskEvent, AskRequest, AskResult, PathInfo } from "@rocky/contracts";
import { anyLocalOnly } from "../notebooks/scope.ts";
import { type Reranker, type RetrievedChunk, retrieve } from "../retrieval/retrieve.ts";
import type { Embedder } from "../router/embed.ts";
import type { Router } from "../router/router.ts";
import type { Db } from "../store/db.ts";
import { answerOverChunks } from "./verified.ts";

export { citedSourceTexts, normalizeForQuote, quoteMatches } from "./verified.ts";

export interface AskDeps {
  db: Db;
  router: Router;
  embedder?: Embedder;
  reranker?: Reranker;
}

export const NOT_FOUND_TEXT = "Not found in your sources.";

const ANSWER_SYSTEM =
  "You answer questions using only the numbered source chunks the user provides.";

function closestMatches(chunks: RetrievedChunk[]) {
  const seen = new Set<string>();
  const out: AskResult["closestMatches"] = [];
  for (const c of chunks) {
    if (seen.has(c.documentId)) continue;
    seen.add(c.documentId);
    out.push({ documentId: c.documentId, title: c.title, chunkId: c.id });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Ask with sources (assistant.md): retrieve → answer as JSON sentences → deterministic quote
 * check → batched verifier → render (verified.ts). Sentences that fail either check are dropped
 * (or returned flagged with showFlagged). If nothing survives, the answer is "Not found in your sources."
 */
export async function ask(
  deps: AskDeps,
  req: AskRequest,
  onEvent: (e: AskEvent) => void = () => {},
): Promise<AskResult> {
  const scope = req.scope;
  // A local-only notebook keeps the whole question local, even in a cross-notebook union.
  const notebookLocal = anyLocalOnly(deps.db, scope?.notebookIds);
  const localOnly = Boolean(scope?.localOnly) || notebookLocal;

  const firstTarget = deps.router.chain("chat", { localOnly })[0];
  const chunks = await retrieve(deps.db, req.question, {
    ...(scope ? { scope } : {}),
    ...(deps.embedder ? { embedder: deps.embedder } : {}),
    ...(deps.reranker ? { reranker: deps.reranker } : {}),
    tokenBudget: firstTarget?.local ? 2500 : 4000,
  });
  onEvent({
    type: "retrieval",
    chunks: chunks.map((c) => ({ id: c.id, docTitle: c.title, anchor: c.anchor })),
  });

  const v = await answerOverChunks(deps, {
    task: "chat",
    origin: "user_turn",
    system: ANSWER_SYSTEM,
    prompt: `Question: ${req.question}`,
    chunks,
    localOnly,
    ...(req.showFlagged ? { showFlagged: true } : {}),
    onEvent,
  });

  const base = {
    path: v.path as PathInfo | null,
    verifierPath: v.verifierPath,
    ...(v.verifierError ? { verifierError: v.verifierError } : {}),
    usage: v.usage,
  };
  const result: AskResult = v.notFound
    ? {
        // Flagged sentences stay visible when asked for, but the answer is still "not found".
        answer: req.showFlagged ? v.answer : [],
        notFound: true,
        closestMatches: closestMatches(chunks),
        ...base,
      }
    : { answer: v.answer, notFound: false, closestMatches: [], ...base };
  onEvent({ type: "done", result });
  return result;
}

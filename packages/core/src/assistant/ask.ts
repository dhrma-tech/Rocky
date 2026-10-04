import {
  type AnswerSentence,
  type AskEvent,
  type AskRequest,
  type AskResult,
  type Citation,
  type ModelAnswer,
  ModelAnswerSchema,
  type PathInfo,
  type SentenceStatus,
  type Usage,
  VerifierOutputSchema,
} from "@rocky/contracts";
import { type Reranker, type RetrievedChunk, retrieve } from "../retrieval/retrieve.ts";
import type { Embedder } from "../router/embed.ts";
import type { Router } from "../router/router.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";

export interface AskDeps {
  db: Db;
  router: Router;
  embedder?: Embedder;
  reranker?: Reranker;
}

export const NOT_FOUND_TEXT = "Not found in your sources.";

/** Quote ≤ 40 words (assistant.md "Prompt rules"). */
const MAX_QUOTE_WORDS = 40;

const ANSWER_SYSTEM = `You answer questions using only the numbered source chunks the user provides.

Rules:
- Use only facts stated in the <untrusted_data> chunks. Never use outside knowledge.
- Reply with JSON: {"sentences":[{"text","citations","quote"}],"notFound":boolean}.
- Every sentence states facts from the chunks. Put the id attribute of each supporting chunk in "citations".
- "quote" is a verbatim excerpt (at most ${MAX_QUOTE_WORDS} words) copied character for character from one of the cited chunks that supports the sentence. Do not paraphrase, fix typos or join separate passages in the quote.
- Do not add sentences without citations.
- If the chunks do not contain the answer, reply {"sentences":[],"notFound":true}.

${UNTRUSTED_RULE}`;

const VERIFY_SYSTEM = `You check whether each claim is supported by its evidence quote.

For each item, label:
- SUPPORTED: the quote fully supports every fact in the claim.
- PARTIAL: the quote supports part of the claim, but some detail is missing or stronger than the quote.
- UNSUPPORTED: the quote does not support the claim, or contradicts it.

Reply with JSON: {"labels":[{"i","label","reason"}]}, one entry per item, reason in one short line.

${UNTRUSTED_RULE}`;

/**
 * Normalization for the deterministic quote check (assistant.md "Verification" 1):
 * whitespace, quotes and dashes, lowercase. Zero-width characters (including the ones the
 * untrusted-data escaper inserts) are dropped.
 */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` is non-trivial, ≤ 40 words, and occurs in at least one of the chunk texts. */
export function quoteMatches(quote: string, chunkTexts: string[]): boolean {
  const q = normalizeForQuote(quote);
  if (q.length < 3 || q.split(" ").length > MAX_QUOTE_WORDS) return false;
  return chunkTexts.some((t) => normalizeForQuote(t).includes(q));
}

/**
 * Texts a quote may come from: each cited chunk, plus the source text just around it. Chunks
 * split mid-sentence, so a verbatim quote can straddle a chunk edge; the window extends the chunk
 * by the quote's length on both sides of its span in documents.raw_text.
 */
export function citedSourceTexts(db: Db, cited: RetrievedChunk[], quote: string): string[] {
  const pad = quote.length + 20;
  const raw = db.prepare("select substr(raw_text, ?, ?) as t from documents where id = ?");
  return cited.flatMap((c) => {
    const start = Math.max(0, c.charStart - pad);
    const row = raw.get(start + 1, c.charEnd + pad - start, c.documentId) as
      | { t: string | null }
      | undefined;
    return row?.t ? [c.text, row.t] : [c.text];
  });
}

function answerPrompt(question: string, chunks: RetrievedChunk[]): string {
  const blocks = chunks.map((c) =>
    wrapUntrusted(c.text, {
      id: c.id,
      source: c.title,
      ...(c.sectionPath ? { section: c.sectionPath } : {}),
      ...(c.anchor.kind === "pdf_page" ? { page: String(c.anchor.page) } : {}),
    }),
  );
  return `Source chunks:\n\n${blocks.join("\n\n")}\n\nQuestion: ${question}`;
}

function verifyPrompt(items: { i: number; text: string; quote: string }[]): string {
  return items
    .map(
      (it) =>
        `Item ${it.i}\nClaim: ${it.text}\nEvidence quote:\n${wrapUntrusted(it.quote, { id: `q${it.i}`, source: "quote" })}`,
    )
    .join("\n\n");
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

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
 * check → batched verifier → render. Sentences that fail either check are dropped (or returned
 * flagged with showFlagged). If nothing survives, the answer is "Not found in your sources."
 */
export async function ask(
  deps: AskDeps,
  req: AskRequest,
  onEvent: (e: AskEvent) => void = () => {},
): Promise<AskResult> {
  const scope = req.scope;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const firstTarget = deps.router.chain("chat", { localOnly: scope?.localOnly })[0];
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

  const notFound = (
    path: PathInfo | null,
    extra: Partial<Pick<AskResult, "answer" | "verifierPath" | "verifierError">> = {},
  ): AskResult => {
    const result: AskResult = {
      answer: [],
      notFound: true,
      closestMatches: closestMatches(chunks),
      path,
      verifierPath: null,
      usage,
      ...extra,
    };
    onEvent({ type: "done", result });
    return result;
  };
  if (chunks.length === 0) return notFound(null);

  // A local-only document anywhere in the context keeps every model call local (SECURITY.md).
  const localOnly = Boolean(scope?.localOnly) || chunks.some((c) => c.localOnly);
  const routeScope = { localOnly };

  const answerRun = await deps.router.run<ModelAnswer>({
    task: "chat",
    origin: "user_turn",
    system: ANSWER_SYSTEM,
    prompt: answerPrompt(req.question, chunks),
    schema: ModelAnswerSchema,
    scope: routeScope,
    hints: { temperature: 0 },
  });
  usage = addUsage(usage, answerRun.usage);
  const draft = answerRun.output;
  if (draft.notFound || draft.sentences.length === 0) return notFound(answerRun.path);

  const byId = new Map(chunks.map((c) => [c.id, c]));

  // Pass 1: deterministic quote check.
  const status = new Map<number, { status: SentenceStatus; reason?: string }>();
  const toVerify: { i: number; text: string; quote: string }[] = [];
  for (const [i, s] of draft.sentences.entries()) {
    onEvent({ type: "draft_sentence", i, text: s.text, citations: s.citations });
    const cited = s.citations.map((id) => byId.get(id)).filter((c) => c !== undefined);
    if (cited.length === 0) {
      status.set(i, { status: "unsupported", reason: "no valid citation" });
    } else if (!quoteMatches(s.quote, citedSourceTexts(deps.db, cited, s.quote))) {
      status.set(i, { status: "unsupported", reason: "quote not found in cited chunks" });
    } else {
      toVerify.push({ i, text: s.text, quote: s.quote });
    }
  }

  // Pass 2: verifier model, batched per answer.
  let verifierPath: PathInfo | null = null;
  let verifierError: string | undefined;
  if (toVerify.length > 0) {
    try {
      const v = await deps.router.run({
        task: "verify",
        origin: "user_turn",
        system: VERIFY_SYSTEM,
        prompt: verifyPrompt(toVerify),
        schema: VerifierOutputSchema,
        scope: routeScope,
        hints: { temperature: 0 },
      });
      usage = addUsage(usage, v.usage);
      verifierPath = v.path;
      const labels = new Map(v.output.labels.map((l) => [l.i, l]));
      for (const it of toVerify) {
        const l = labels.get(it.i);
        status.set(
          it.i,
          l
            ? { status: l.label.toLowerCase() as SentenceStatus, reason: l.reason }
            : { status: "unsupported", reason: "verifier returned no label" },
        );
      }
    } catch (err) {
      // The quote check already passed; without a verifier the sentence is shown, marked partial.
      verifierError = err instanceof Error ? err.message : String(err);
      for (const it of toVerify)
        status.set(it.i, { status: "partial", reason: "verifier unavailable" });
    }
  }

  // Pass 3: render.
  const answer: AnswerSentence[] = [];
  for (const [i, s] of draft.sentences.entries()) {
    const st = status.get(i) ?? { status: "unsupported" as const };
    onEvent({ type: "verified", i, status: st.status, quote: s.quote });
    if (st.status === "unsupported" && !req.showFlagged) continue;
    const citations: Citation[] = s.citations
      .map((id) => byId.get(id))
      .filter((c) => c !== undefined)
      .map((c) => ({
        chunkId: c.id,
        documentId: c.documentId,
        title: c.title,
        anchor: c.anchor,
        quote: s.quote,
      }));
    answer.push({
      i,
      text: s.text,
      status: st.status,
      ...(st.reason ? { reason: st.reason } : {}),
      citations,
    });
  }

  if (!answer.some((s) => s.status !== "unsupported")) {
    // Flagged sentences stay visible when asked for, but the answer is still "not found".
    return notFound(answerRun.path, {
      verifierPath,
      ...(req.showFlagged ? { answer } : {}),
      ...(verifierError ? { verifierError } : {}),
    });
  }

  const result: AskResult = {
    answer,
    notFound: false,
    closestMatches: [],
    path: answerRun.path,
    verifierPath,
    ...(verifierError ? { verifierError } : {}),
    usage,
  };
  onEvent({ type: "done", result });
  return result;
}

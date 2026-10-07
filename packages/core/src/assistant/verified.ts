import {
  type AnswerSentence,
  type AskEvent,
  type Citation,
  type ModelAnswer,
  ModelAnswerSchema,
  type PathInfo,
  type SentenceStatus,
  type Task,
  type Usage,
  VerifierOutputSchema,
} from "@rocky/contracts";
import type { RetrievedChunk } from "../retrieval/retrieve.ts";
import type { Router } from "../router/router.ts";
import { UNTRUSTED_RULE, wrapUntrusted } from "../security/untrusted.ts";
import type { Db } from "../store/db.ts";

/**
 * Verified generation (assistant.md "Verification", non-negotiable #4), shared by Ask, briefs and
 * routines: the model answers as JSON sentences that cite chunk ids with a verbatim quote, then
 * (1) a deterministic quote check and (2) a batched verifier label every sentence. Only
 * SUPPORTED and PARTIAL sentences survive (UNSUPPORTED ones only with showFlagged).
 */

/** Quote ≤ 40 words (assistant.md "Prompt rules"). */
export const MAX_QUOTE_WORDS = 40;

export const SENTENCE_RULES = `Rules:
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

/** Chunks as untrusted blocks the model cites by id. */
export function chunksPrompt(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) =>
      wrapUntrusted(c.text, {
        id: c.id,
        source: c.title,
        ...(c.sectionPath ? { section: c.sectionPath } : {}),
        ...(c.anchor.kind === "pdf_page" ? { page: String(c.anchor.page) } : {}),
      }),
    )
    .join("\n\n");
}

function verifyPrompt(items: { i: number; text: string; quote: string }[]): string {
  return items
    .map(
      (it) =>
        `Item ${it.i}\nClaim: ${it.text}\nEvidence quote:\n${wrapUntrusted(it.quote, { id: `q${it.i}`, source: "quote" })}`,
    )
    .join("\n\n");
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

export interface VerifiedAnswer {
  /** Kept sentences (flagged ones too when showFlagged). Empty when nothing survived. */
  answer: AnswerSentence[];
  /** True when the model said so, or no sentence survived verification. */
  notFound: boolean;
  path: PathInfo | null;
  verifierPath: PathInfo | null;
  verifierError?: string;
  usage: Usage;
}

export interface AnswerOptions {
  task: Task;
  origin: string;
  /** Task framing; the sentence rules are appended. */
  system: string;
  /** The instruction or question; the chunks are prepended. */
  prompt: string;
  chunks: RetrievedChunk[];
  /** A local-only scope or any local-only chunk keeps both model calls local. */
  localOnly?: boolean;
  showFlagged?: boolean;
  onEvent?: (e: AskEvent) => void;
}

/** Generate cited sentences over the given chunks and verify them (both passes). */
export async function answerOverChunks(
  deps: { db: Db; router: Router },
  opts: AnswerOptions,
): Promise<VerifiedAnswer> {
  const onEvent = opts.onEvent ?? (() => {});
  let usage = ZERO_USAGE;
  if (opts.chunks.length === 0)
    return { answer: [], notFound: true, path: null, verifierPath: null, usage };
  // A local-only document anywhere in the context keeps every model call local (SECURITY.md).
  const localOnly = Boolean(opts.localOnly) || opts.chunks.some((c) => c.localOnly);
  const scope = { localOnly };

  const run = await deps.router.run<ModelAnswer>({
    task: opts.task,
    origin: opts.origin,
    system: `${opts.system}\n\n${SENTENCE_RULES}`,
    prompt: `Source chunks:\n\n${chunksPrompt(opts.chunks)}\n\n${opts.prompt}`,
    schema: ModelAnswerSchema,
    scope,
    hints: { temperature: 0 },
  });
  usage = addUsage(usage, run.usage);
  const draft = run.output;
  if (draft.notFound || draft.sentences.length === 0)
    return { answer: [], notFound: true, path: run.path, verifierPath: null, usage };

  const byId = new Map(opts.chunks.map((c) => [c.id, c]));

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
        origin: opts.origin,
        system: VERIFY_SYSTEM,
        prompt: verifyPrompt(toVerify),
        schema: VerifierOutputSchema,
        scope,
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
      // Non-negotiable #4: an answer needs both passes. Unverified sentences are not shown.
      verifierError = err instanceof Error ? err.message : String(err);
      for (const it of toVerify)
        status.set(it.i, { status: "unsupported", reason: "verifier unavailable" });
    }
  }

  // Pass 3: render.
  const answer: AnswerSentence[] = [];
  for (const [i, s] of draft.sentences.entries()) {
    const st = status.get(i) ?? { status: "unsupported" as const };
    onEvent({ type: "verified", i, status: st.status, quote: s.quote });
    if (st.status === "unsupported" && !opts.showFlagged) continue;
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

  return {
    answer,
    notFound: !answer.some((s) => s.status !== "unsupported"),
    path: run.path,
    verifierPath,
    ...(verifierError ? { verifierError } : {}),
    usage,
  };
}

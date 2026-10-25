import type {
  AskEvent,
  AskRequest,
  AskResult,
  Origin,
  OutboundPreview,
  PathInfo,
} from "@rocky/contracts";
import { anyLocalOnly } from "../notebooks/scope.ts";
import { chunksById, type Reranker, type RetrievedChunk, retrieve } from "../retrieval/retrieve.ts";
import { type OutboundConsents, passagesHash } from "../router/consent.ts";
import type { Embedder } from "../router/embed.ts";
import type { Router } from "../router/router.ts";
import { sensitiveTags } from "../security/sensitive.ts";
import type { Db } from "../store/db.ts";
import { answerOverChunks, ZERO_USAGE } from "./verified.ts";

export { citedSourceTexts, normalizeForQuote, quoteMatches } from "./verified.ts";

export interface AskDeps {
  db: Db;
  router: Router;
  embedder?: Embedder;
  reranker?: Reranker;
  /**
   * Outbound previews (roadmap M4, D-068). Without them, or without `cloudReady`, every
   * question is answered on this computer and the cloud is never offered.
   */
  consents?: OutboundConsents;
  /** Whether a cloud call could be made at all (a key for that provider is stored). */
  cloudReady?: (provider: string) => boolean;
  /** "system" for evals: the gate treats them as background work, never as a question. */
  origin?: Origin;
}

export const NOT_FOUND_TEXT = "Not found in your sources.";

/** Below this share of drafted sentences passing both checks, a local answer counts as weak. */
export const ESCALATE_BELOW = 0.5;

const ANSWER_SYSTEM =
  "You answer questions using only the numbered source chunks the user provides.";

/** Retrieval budgets (memory.md): what a local model and a cloud model can take. */
const BUDGET = { local: 2500, cloud: 4000 };

export class ConsentInvalid extends Error {
  readonly code = "CONSENT_INVALID";
}

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

/** Same scope, same token: a consent can't be spent on another notebook or project. */
const scopeKey = (req: AskRequest) => JSON.stringify(req.scope ?? {});

/**
 * Ask with sources (assistant.md): retrieve → answer as JSON sentences → deterministic quote
 * check → batched verifier → render (verified.ts). Sentences that fail either check are dropped
 * (or returned flagged with showFlagged). If nothing survives, the answer is "Not found in your sources."
 *
 * Routing (roadmap M4, D-068): a question is answered on this computer unless the user sends it
 * to the cloud, and then only after seeing the exact passages (the outbound preview) and agreeing.
 * The cloud is offered when the user picks it, or when the local answer came back weak.
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

  if (req.consent) return answerInCloud(deps, req, req.consent, localOnly, onEvent);

  const cloud = cloudTargets(deps, localOnly);
  const route = req.route ?? (deps.router.mode() === "cloud_first" ? "cloud" : "local");
  const fetch = (budget: number) =>
    retrieve(deps.db, req.question, {
      ...(scope ? { scope } : {}),
      ...(deps.embedder ? { embedder: deps.embedder } : {}),
      ...(deps.reranker ? { reranker: deps.reranker } : {}),
      tokenBudget: budget,
    });
  const announce = (chunks: RetrievedChunk[]) =>
    onEvent({
      type: "retrieval",
      chunks: chunks.map((c) => ({ id: c.id, docTitle: c.title, anchor: c.anchor })),
    });

  // Cloud picked: show what would leave, answer nothing yet.
  if (route === "cloud" && cloud) {
    const chunks = await fetch(BUDGET.cloud);
    announce(chunks);
    const preview = chunks.some((c) => c.localOnly)
      ? null
      : offer(deps, req, chunks, "asked", cloud);
    if (preview) {
      onEvent({ type: "outbound", preview });
      const result: AskResult = {
        answer: [],
        notFound: false,
        closestMatches: [],
        path: null,
        verifierPath: null,
        usage: ZERO_USAGE,
        outbound: preview,
        awaitingConsent: true,
      };
      onEvent({ type: "done", result });
      return result;
    }
    // Nothing to send (no passages) or a local-only passage: answer here instead.
  }

  const chunks = await fetch(BUDGET.local);
  announce(chunks);
  const v = await answerOverChunks(deps, {
    task: "chat",
    origin: deps.origin ?? "user_turn",
    system: ANSWER_SYSTEM,
    prompt: `Question: ${req.question}`,
    chunks,
    localOnly,
    // Without the consent registry (older seams, evals) policies.yaml decides, as before M4.
    ...(deps.consents ? { route: "local" as const } : {}),
    ...(req.showFlagged ? { showFlagged: true } : {}),
    onEvent,
  });

  // A weak local answer: offer the cloud, with its own (larger) set of passages.
  let outbound: OutboundPreview | undefined;
  const weak = v.notFound || (v.drafted > 0 && v.passed / v.drafted < ESCALATE_BELOW);
  if (weak && cloud && chunks.length > 0) {
    const wider = await fetch(BUDGET.cloud);
    const preview = wider.some((c) => c.localOnly)
      ? null
      : offer(deps, req, wider, v.notFound ? "not_found" : "low_verification", cloud);
    if (preview) {
      outbound = preview;
      onEvent({ type: "outbound", preview });
    }
  }
  const result = toResult(v, req, chunks, outbound);
  onEvent({ type: "done", result });
  return result;
}

/** The cloud models a consented question would use, or null when the cloud is out of reach. */
function cloudTargets(
  deps: AskDeps,
  localOnly: boolean,
): { model: string; verifier: string | null } | null {
  if (!deps.consents || !deps.cloudReady || localOnly) return null;
  const chat = deps.router.cloudChain("chat", { localOnly })[0];
  if (!chat || !deps.cloudReady(chat.provider)) return null;
  const verify = deps.router.cloudChain("verify", { localOnly })[0];
  return {
    model: `${chat.provider}/${chat.model}`,
    verifier:
      verify && deps.cloudReady(verify.provider) ? `${verify.provider}/${verify.model}` : null,
  };
}

function offer(
  deps: AskDeps,
  req: AskRequest,
  chunks: RetrievedChunk[],
  reason: OutboundPreview["reason"],
  cloud: { model: string; verifier: string | null },
): OutboundPreview | null {
  if (!deps.consents || chunks.length === 0) return null;
  const { token, expiresAt } = deps.consents.offer({
    question: req.question,
    scopeKey: scopeKey(req),
    chunkIds: chunks.map((c) => c.id),
    textHash: passagesHash(chunks.map((c) => c.text)),
  });
  return {
    token,
    reason,
    model: cloud.model,
    verifier: cloud.verifier,
    passages: chunks.map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      title: c.title,
      text: c.text,
      tags: sensitiveTags(`${c.title}\n${c.text}`),
    })),
    expiresAt,
  };
}

/** The user agreed: answer over exactly the passages they saw, in the cloud, then spend the token. */
async function answerInCloud(
  deps: AskDeps,
  req: AskRequest,
  token: string,
  localOnly: boolean,
  onEvent: (e: AskEvent) => void,
): Promise<AskResult> {
  const offered = deps.consents?.redeem(token, req.question, scopeKey(req));
  if (!offered)
    throw new ConsentInvalid(
      "That preview has expired or was already used. Ask again to see the passages.",
    );
  try {
    if (localOnly) throw new ConsentInvalid("This question's scope is local-only now.");
    const chunks = chunksById(deps.db, offered.chunkIds);
    // A source changed, was deleted, or turned local-only since the preview: the user agreed to
    // different text, so nothing is sent.
    if (
      chunks.length !== offered.chunkIds.length ||
      chunks.some((c) => c.localOnly) ||
      passagesHash(chunks.map((c) => c.text)) !== offered.textHash
    )
      throw new ConsentInvalid("Your sources changed since the preview. Ask again to see them.");
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
      route: "cloud",
      consent: token,
      ...(req.showFlagged ? { showFlagged: true } : {}),
      onEvent,
    });
    const result = toResult(v, req, chunks, undefined);
    onEvent({ type: "done", result });
    return result;
  } finally {
    deps.consents?.finish(token);
  }
}

function toResult(
  v: Awaited<ReturnType<typeof answerOverChunks>>,
  req: AskRequest,
  chunks: RetrievedChunk[],
  outbound: OutboundPreview | undefined,
): AskResult {
  const base = {
    path: v.path as PathInfo | null,
    verifierPath: v.verifierPath,
    ...(v.verifierError ? { verifierError: v.verifierError } : {}),
    usage: v.usage,
    ...(outbound ? { outbound } : {}),
  };
  return v.notFound
    ? {
        // Flagged sentences stay visible when asked for, but the answer is still "not found".
        answer: req.showFlagged ? v.answer : [],
        notFound: true,
        closestMatches: closestMatches(chunks),
        ...base,
      }
    : { answer: v.answer, notFound: false, closestMatches: [], ...base };
}

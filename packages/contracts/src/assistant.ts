import { z } from "zod";
import { CitationSchema, ScopeSchema } from "./memory.ts";
import { PathInfoSchema, UsageSchema } from "./router.ts";

/** What the answer model must return (assistant.md "Answer schema"). */
export const ModelAnswerSchema = z.object({
  sentences: z.array(
    z.object({
      text: z.string(),
      citations: z.array(z.string()),
      quote: z.string(),
    }),
  ),
  notFound: z.boolean(),
});
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

export const VerifyLabelSchema = z.enum(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]);

/** What the verifier model must return, one label per sentence index. */
export const VerifierOutputSchema = z.object({
  labels: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      label: VerifyLabelSchema,
      reason: z.string(),
    }),
  ),
});
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export const SentenceStatusSchema = z.enum(["supported", "partial", "unsupported"]);
export type SentenceStatus = z.infer<typeof SentenceStatusSchema>;

export const AnswerSentenceSchema = z.object({
  i: z.number().int(),
  text: z.string(),
  status: SentenceStatusSchema,
  /** Why the sentence got its status: "quote not found in cited chunks", the verifier's reason, ... */
  reason: z.string().optional(),
  citations: z.array(CitationSchema),
});
export type AnswerSentence = z.infer<typeof AnswerSentenceSchema>;

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(4000),
  scope: ScopeSchema.optional(),
  showFlagged: z.boolean().optional(),
  /**
   * The per-question switch (roadmap M4, D-068). "local" answers on this computer; "cloud" first
   * returns the outbound preview. Omitted: the routing mode decides (local_first → local).
   */
  route: z.enum(["local", "cloud"]).optional(),
  /** The preview's token, sent back when the user agrees to send those passages. One use. */
  consent: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const ClosestMatchSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  chunkId: z.string(),
});

/** What a passage contains that the user may not want to send (regex, never a model). */
export const SensitiveTagSchema = z.enum([
  "email",
  "phone",
  "card_number",
  "iban",
  "id_number",
  "secret",
]);
export type SensitiveTag = z.infer<typeof SensitiveTagSchema>;

/**
 * The outbound preview (D-020, D-068): exactly the passages a cloud call for this question would
 * send, shown before it is made. The question itself goes too.
 */
export const OutboundPreviewSchema = z.object({
  token: z.string(),
  /** Why it is offered: the user picked the cloud, or the local answer came back weak. */
  reason: z.enum(["asked", "not_found", "low_verification"]),
  /** provider/model of the answer call; the check goes to `verifier`. */
  model: z.string(),
  verifier: z.string().nullable(),
  passages: z.array(
    z.object({
      chunkId: z.string(),
      documentId: z.string(),
      title: z.string(),
      text: z.string(),
      tags: z.array(SensitiveTagSchema),
    }),
  ),
  expiresAt: z.number().int(),
});
export type OutboundPreview = z.infer<typeof OutboundPreviewSchema>;

export const AskResultSchema = z.object({
  /** Shown sentences: supported and partial, plus unsupported ones when showFlagged is on. */
  answer: z.array(AnswerSentenceSchema),
  notFound: z.boolean(),
  /** Top retrieved sources, listed when the answer is "Not found in your sources." */
  closestMatches: z.array(ClosestMatchSchema),
  path: PathInfoSchema.nullable(),
  verifierPath: PathInfoSchema.nullable(),
  /** Set when the verifier could not run; its sentences are then withheld as unsupported. */
  verifierError: z.string().optional(),
  usage: UsageSchema,
  /**
   * Set when a cloud call is on offer (D-068). With `awaitingConsent`, nothing was answered yet:
   * the user picked the cloud and must first agree to these passages.
   */
  outbound: OutboundPreviewSchema.optional(),
  awaitingConsent: z.boolean().optional(),
});
export type AskResult = z.infer<typeof AskResultSchema>;

/** SSE events for POST /api/v1/ask (assistant.md). */
export type AskEvent =
  | { type: "retrieval"; chunks: { id: string; docTitle: string; anchor: unknown }[] }
  | { type: "outbound"; preview: OutboundPreview }
  | { type: "draft_sentence"; i: number; text: string; citations: string[] }
  | { type: "verified"; i: number; status: SentenceStatus; quote: string }
  | { type: "done"; result: AskResult };

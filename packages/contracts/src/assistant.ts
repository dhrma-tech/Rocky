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
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const ClosestMatchSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  chunkId: z.string(),
});

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
});
export type AskResult = z.infer<typeof AskResultSchema>;

/** SSE events for POST /api/v1/ask (assistant.md). */
export type AskEvent =
  | { type: "retrieval"; chunks: { id: string; docTitle: string; anchor: unknown }[] }
  | { type: "draft_sentence"; i: number; text: string; citations: string[] }
  | { type: "verified"; i: number; status: SentenceStatus; quote: string }
  | { type: "done"; result: AskResult };

import { z } from "zod";
import { CitationSchema } from "./memory.ts";

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/** specs/actions.md state machine. */
export const ActionStatusSchema = z.enum([
  "draft",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** What the approval card shows; produced by the action's `describe()`. */
export const ActionDescriptionSchema = z.object({
  target: z.string(),
  summary: z.string(),
  diff: z.unknown().optional(),
});
export type ActionDescription = z.infer<typeof ActionDescriptionSchema>;

/**
 * Where a proposal's content came from (roadmap I1): each cited source, whether a third party
 * could have written it, and any instruction-like text the flagger found in it.
 */
export const ProvenanceSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  sourceType: z.string(),
  connectorId: z.string().nullable(),
  /** Mail, chat, web pages, PDFs, synced apps: text someone other than the user may control. */
  external: z.boolean(),
  /** Flagger reasons; non-empty means the source contains instruction-like text. */
  flags: z.array(z.string()),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** "strict" when external or flagged text motivated the action: approving needs an explicit acknowledgement. */
export const ReviewLevelSchema = z.enum(["standard", "strict"]);
export type ReviewLevel = z.infer<typeof ReviewLevelSchema>;

export const ActionRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  connectorId: z.string().nullable(),
  payload: z.unknown(),
  /** sha256(canonical(payload)); the UI sends it back on approve. */
  payloadHash: z.string(),
  risk: RiskSchema,
  status: ActionStatusSchema,
  origin: z.string(),
  citations: z.array(CitationSchema),
  /** A cited source was flagged as possibly containing injected instructions. */
  suspicious: z.boolean(),
  provenance: z.array(ProvenanceSchema),
  review: ReviewLevelSchema,
  description: ActionDescriptionSchema,
  idempotencyKey: z.string(),
  approvedAt: z.number().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const ApproveRequestSchema = z.object({
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Required for review "strict": the user saw where the content came from. */
  acknowledgeSources: z.literal(true).optional(),
});
export const EditRequestSchema = z.object({ payload: z.unknown() });

export const AuditRowSchema = z.object({
  seq: z.number(),
  at: z.number(),
  eventType: z.string(),
  actor: z.enum(["user", "routine", "system"]),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  payloadHash: z.string().nullable(),
  /** null once purged by deletion; the chain still verifies (it covers only the hash). */
  payload: z.unknown().nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

export const AuditVerifySchema = z.object({
  ok: z.boolean(),
  checked: z.number(),
  firstBrokenSeq: z.number().optional(),
  reason: z.string().optional(),
});
export type AuditVerify = z.infer<typeof AuditVerifySchema>;

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

/**
 * What an action does to the world outside Rocky (UI spec "scope and risk chip"). Declared by the
 * connector; "send" covers anything that notifies other people (a calendar invite with guests).
 */
export const ActionClassSchema = z.enum(["write", "send", "spend", "delete"]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

/** Classes a rule may never allow without asking (roadmap A4: sends and deletes default to ask). */
export const ALWAYS_ASK_CLASSES: readonly ActionClass[] = ["send", "spend", "delete"];

/** Who approved: the user, or a rule the user made (the audit entry names it either way). */
export const ApprovedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("rule"), ruleId: z.string() }),
]);
export type ApprovedBy = z.infer<typeof ApprovedBySchema>;

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
  actionClass: ActionClassSchema,
  description: ActionDescriptionSchema,
  idempotencyKey: z.string(),
  approvedAt: z.number().nullable(),
  approvedBy: ApprovedBySchema.nullable(),
  /** Approved actions wait until this time so Undo still works; null means run by hand. */
  executeAfter: z.number().nullable(),
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
  /** "Approve now" sends 0; otherwise the action waits 10 s so Undo can still stop it. */
  holdMs: z.number().int().min(0).max(60_000).optional(),
});

// --- Rules and grants (roadmap A4) ---

export const RuleEffectSchema = z.enum(["allow", "ask", "block"]);
export type RuleEffect = z.infer<typeof RuleEffectSchema>;

/**
 * A condition on the proposed payload. `field` is a dot path ("repo", "to", "attendees").
 * equals / oneOf compare values; domainIn needs every email address in the field to be at one of
 * the domains; lte bounds a number (an amount).
 */
export const RuleConstraintSchema = z.discriminatedUnion("op", [
  z.object({
    field: z.string().min(1).max(100),
    op: z.literal("equals"),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    field: z.string().min(1).max(100),
    op: z.literal("oneOf"),
    value: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .max(100),
  }),
  z.object({
    field: z.string().min(1).max(100),
    op: z.literal("domainIn"),
    value: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i))
      .min(1)
      .max(50),
  }),
  z.object({ field: z.string().min(1).max(100), op: z.literal("lte"), value: z.number() }),
]);
export type RuleConstraint = z.infer<typeof RuleConstraintSchema>;

const RuleScope = {
  /** null: any connector. */
  connectorId: z.string().nullable(),
  /** null: any type (narrow with actionClass). */
  actionType: z.string().nullable(),
  actionClass: ActionClassSchema.nullable(),
  constraints: z.array(RuleConstraintSchema).max(20),
};

export const ActionRuleSchema = z.object({
  id: z.string(),
  effect: RuleEffectSchema,
  ...RuleScope,
  /** ms UTC; null only for ask and block rules. */
  expiresAt: z.number().nullable(),
  /** One-time grants have 1; null means no use limit (until expiry). */
  usesLeft: z.number().int().nullable(),
  /** The action this rule was made from ("Always allow actions like this"), if any. */
  fromActionId: z.string().nullable(),
  note: z.string(),
  /** The plain-language sentence shown before saving and in the rules list. */
  sentence: z.string(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
  active: z.boolean(),
});
export type ActionRule = z.infer<typeof ActionRuleSchema>;

/** 90 days: a grant that outlives a term or a quarter should be made again on purpose. */
export const MAX_GRANT_MS = 90 * 86_400_000;

export const RuleCreateSchema = z
  .object({
    effect: RuleEffectSchema,
    ...RuleScope,
    expiresAt: z.number().int().nullable().default(null),
    usesLeft: z.number().int().min(1).max(1000).nullable().default(null),
    fromActionId: z.string().nullable().default(null),
    note: z.string().max(500).default(""),
  })
  .strict();
export type RuleCreate = z.input<typeof RuleCreateSchema>;

export const RulePreviewSchema = z.object({
  sentence: z.string(),
  /** Past approvals (last 90 days) this rule would have skipped, for "Ask → Allow". */
  wouldHaveSkipped: z.number().int().nonnegative(),
  /** Why the rule can't be saved, if it can't. */
  problems: z.array(z.string()),
});
export type RulePreview = z.infer<typeof RulePreviewSchema>;
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

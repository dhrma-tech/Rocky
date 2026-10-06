import { z } from "zod";
import { MeetingSchema, TranscriptSegmentSchema } from "./capture.ts";
import { AnchorSchema } from "./memory.ts";
import { PathInfoSchema } from "./router.ts";

/**
 * Spec: assistant.md "Understanding". What the extraction model returns per transcript window.
 * Optional fields are nullable rather than omitted: small local models handle that more reliably.
 */
export const ExtractedCommitmentSchema = z.object({
  text: z.string().min(1),
  /** A name, or "me" for the person recording. */
  owner: z.string().min(1),
  counterparty: z.string().nullable(),
  /** As stated ("by Friday"); parsed later with chrono-node. */
  deadline: z.string().nullable(),
  /** Exact words from the referenced segment. */
  evidenceQuote: z.string().min(1),
  /** Segment id, e.g. "s12". */
  segmentRef: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedCommitment = z.infer<typeof ExtractedCommitmentSchema>;

export const ExtractedDecisionSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  evidenceQuote: z.string().min(1),
  segmentRef: z.string(),
});
export type ExtractedDecision = z.infer<typeof ExtractedDecisionSchema>;

export const EntityKindSchema = z.enum(["person", "org", "course", "project"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  kind: EntityKindSchema,
  email: z.string().nullable(),
  mentions: z.array(z.string()),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractionSchema = z.object({
  /** Two to four sentences on what this part of the transcript covers; feeds the meeting summary. */
  notes: z.string(),
  commitments: z.array(ExtractedCommitmentSchema),
  decisions: z.array(ExtractedDecisionSchema),
  entities: z.array(ExtractedEntitySchema),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const MeetingSummarySchema = z.object({
  title: z.string().min(1),
  /** At most about 200 words. */
  summary: z.string(),
  topics: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const CommitmentStatusSchema = z.enum(["open", "done", "dropped", "waiting"]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const CommitmentSchema = z.object({
  id: z.string(),
  text: z.string(),
  ownerEntityId: z.string().nullable(),
  ownerName: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  /** ms UTC, or null when no date could be parsed. */
  deadline: z.number().int().nullable(),
  /** The deadline as stated in the source. */
  deadlineText: z.string().nullable(),
  status: CommitmentStatusSchema,
  documentId: z.string(),
  documentTitle: z.string(),
  meetingId: z.string().nullable(),
  anchor: AnchorSchema,
  evidenceQuote: z.string(),
  confidence: z.number().nullable(),
  userEdited: z.boolean(),
  createdAt: z.number().int(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  text: z.string(),
  ownerEntityId: z.string().nullable(),
  ownerName: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  documentId: z.string(),
  documentTitle: z.string(),
  meetingId: z.string().nullable(),
  anchor: AnchorSchema,
  evidenceQuote: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const EntitySchema = z.object({
  id: z.string(),
  kind: EntityKindSchema,
  displayName: z.string(),
  primaryEmail: z.string().nullable(),
  unconfirmed: z.boolean(),
  aliases: z.array(z.string()),
});
export type Entity = z.infer<typeof EntitySchema>;

export const StoredSummarySchema = MeetingSummarySchema.extend({ path: PathInfoSchema.nullable() });
export type StoredSummary = z.infer<typeof StoredSummarySchema>;

export const MeetingDetailSchema = z.object({
  meeting: MeetingSchema,
  segments: z.array(TranscriptSegmentSchema),
  summary: StoredSummarySchema.nullable(),
  commitments: z.array(CommitmentSchema),
  decisions: z.array(DecisionSchema),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

/** PATCH /commitments/:id. Any edit marks the row user_edited so re-extraction keeps it. */
export const CommitmentPatchSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    status: CommitmentStatusSchema,
    ownerEntityId: z.string().nullable(),
    /** ms UTC or null to clear. */
    deadline: z.number().int().nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type CommitmentPatch = z.infer<typeof CommitmentPatchSchema>;

/** POST /commitments: a manual commitment, optionally tied to a document chunk. */
export const CommitmentCreateSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    ownerEntityId: z.string().nullable().optional(),
    deadline: z.number().int().nullable().optional(),
    documentId: z.string(),
    anchor: AnchorSchema.optional(),
    evidenceQuote: z.string().max(2000).optional(),
  })
  .strict();
export type CommitmentCreate = z.infer<typeof CommitmentCreateSchema>;

export const EntityMergeSchema = z.object({ into: z.string() }).strict();

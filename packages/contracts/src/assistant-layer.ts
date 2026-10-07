import { z } from "zod";
import { AnswerSentenceSchema } from "./assistant.ts";
import { PathInfoSchema } from "./router.ts";
import { CommitmentSchema } from "./understanding.ts";

/** Phase 6 (assistant.md): briefs, routines, drafts, proposals from content, timeline, home. */

// --- briefs ---

export const BriefRequestSchema = z.union([
  /** A calendar event (its document id). */
  z.object({ eventId: z.string().min(1) }).strict(),
  /** A class: the notebook's next session. */
  z.object({ notebookId: z.string().min(1) }).strict(),
]);
export type BriefRequest = z.infer<typeof BriefRequestSchema>;

export const BriefSchema = z.object({
  id: z.string(),
  kind: z.enum(["event", "notebook"]),
  subjectId: z.string(),
  title: z.string(),
  answer: z.array(AnswerSentenceSchema),
  notFound: z.boolean(),
  path: PathInfoSchema.nullable(),
  createdAt: z.number().int(),
});
export type Brief = z.infer<typeof BriefSchema>;

// --- routines ---

/** Named context collectors a routine can use (routines.ts). */
export const RoutineInputSchema = z.enum([
  "calendar_today",
  "meetings_today",
  "week_meetings",
  "commitments_due_7d",
  "overdue",
  "deadlines_14d",
  "unread_important_threads",
]);
export type RoutineInput = z.infer<typeof RoutineInputSchema>;

const cron = z
  .string()
  .trim()
  .regex(/^\S+(\s+\S+){4}$/, "five cron fields: minute hour day-of-month month day-of-week");

export const RoutineRunSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  status: z.enum(["running", "done", "failed"]),
  answer: z.array(AnswerSentenceSchema),
  notFound: z.boolean(),
  error: z.string().nullable(),
  path: PathInfoSchema.nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Template pack and file it came from; null for routines made in the UI. */
  pack: z.string().nullable(),
  template: z.string().nullable(),
  schedule: z.string(),
  enabled: z.boolean(),
  inputs: z.array(RoutineInputSchema),
  /** The prompt in effect (the user's edit, else the template's). */
  prompt: z.string(),
  edited: z.boolean(),
  lastRunAt: z.number().int().nullable(),
  nextRunAt: z.number().int().nullable(),
  lastRun: RoutineRunSchema.nullable(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const RoutineCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    schedule: cron,
    inputs: z.array(RoutineInputSchema).min(1).max(7),
    prompt: z.string().trim().min(1).max(8000),
    enabled: z.boolean().default(false),
  })
  .strict();
export type RoutineCreate = z.input<typeof RoutineCreateSchema>;

export const RoutineUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    schedule: cron,
    inputs: z.array(RoutineInputSchema).min(1).max(7),
    /** null restores the template's prompt. */
    prompt: z.string().trim().min(1).max(8000).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
export type RoutineUpdate = z.infer<typeof RoutineUpdateSchema>;

// --- timeline and home ---

export const TimelineItemSchema = z.object({
  kind: z.enum(["event", "task", "notion", "commitment", "exam"]),
  title: z.string(),
  start: z.number().int(),
  end: z.number().int().nullable(),
  /** Set for items with a due date rather than a time slot. */
  due: z.number().int().nullable(),
  allDay: z.boolean(),
  /** Connector id (gcal, notion, github) or "commitments" / "notebooks". */
  source: z.string(),
  deepLink: z.string().nullable(),
  documentId: z.string().nullable(),
  /** Other sources merged into this item (same title, same time). */
  mergedFrom: z.array(z.string()),
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const HomeSummarySchema = z.object({
  today: z.array(TimelineItemSchema),
  dueSoon: z.array(CommitmentSchema),
  overdue: z.array(CommitmentSchema),
  pendingApprovals: z.number().int(),
  lastRun: z
    .object({
      routineId: z.string(),
      name: z.string(),
      run: RoutineRunSchema,
    })
    .nullable(),
});
export type HomeSummary = z.infer<typeof HomeSummarySchema>;

// --- drafts and proposals ---

export const DraftRequestSchema = z
  .object({
    instruction: z.string().trim().min(3).max(2000),
    /** Document id of the email thread to reply to; found by retrieval when omitted. */
    threadId: z.string().optional(),
    channel: z.literal("email").default("email"),
  })
  .strict();
export type DraftRequest = z.input<typeof DraftRequestSchema>;

export const ProposeRequestFromDocumentSchema = z
  .object({
    documentId: z.string().min(1),
    instruction: z.string().trim().min(3).max(2000),
  })
  .strict();
export type ProposeFromDocument = z.infer<typeof ProposeRequestFromDocumentSchema>;

// --- model output schemas (nullable rather than optional: small local models do better) ---

const RefQuote = z.object({ chunkRef: z.string(), quote: z.string().min(1) });

export const DraftOutSchema = z.object({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string().min(1),
  body: z.string().min(1),
  citations: z.array(RefQuote),
});
export type DraftOut = z.infer<typeof DraftOutSchema>;

export const ActionTypesOutSchema = z.object({ types: z.array(z.string()) });

export const ProposalsOutSchema = z.object({
  proposals: z.array(
    z.object({
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
      citations: z.array(RefQuote),
    }),
  ),
});
export type ProposalsOut = z.infer<typeof ProposalsOutSchema>;

export const StyleOutSchema = z.object({
  descriptor: z.string().min(1).max(1200),
  /** Verbatim snippets of the user's own sent mail. */
  exemplars: z.array(z.string().min(1).max(600)),
});
export type StyleOut = z.infer<typeof StyleOutSchema>;

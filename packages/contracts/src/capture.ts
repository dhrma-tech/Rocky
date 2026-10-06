import { z } from "zod";

/** Spec: capture.md. Recording, media import and meetings. */

export const MeetingKindSchema = z.enum(["meeting", "lecture"]);
export type MeetingKind = z.infer<typeof MeetingKindSchema>;

export const ChannelSchema = z.enum(["mic", "system", "mixed"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const TranscriptionStatusSchema = z.enum([
  "recording",
  "queued",
  "transcribing",
  "understanding",
  "done",
  "failed",
]);
export type TranscriptionStatus = z.infer<typeof TranscriptionStatusSchema>;

/** POST /recordings. Both consent boxes must be ticked; the consent is written to the audit log. */
export const RecordingStartSchema = z
  .object({
    kind: MeetingKindSchema,
    title: z.string().trim().min(1).max(200).optional(),
    notebookId: z.string().optional(),
    calendarEventId: z.string().max(500).optional(),
    consent: z.object({ participantsInformed: z.literal(true), lawsAck: z.literal(true) }).strict(),
  })
  .strict();
export type RecordingStart = z.infer<typeof RecordingStartSchema>;

/** POST /imports/media/path: a file already on this machine (CLI). */
export const MediaImportPathSchema = z
  .object({
    path: z.string().min(1),
    kind: MeetingKindSchema.default("lecture"),
    title: z.string().trim().min(1).max(200).optional(),
    notebookId: z.string().optional(),
  })
  .strict();
export type MediaImportPath = z.infer<typeof MediaImportPathSchema>;

export const TranscriptSegmentSchema = z.object({
  id: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  channel: ChannelSchema,
  speakerLabel: z.string(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const MeetingSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  kind: MeetingKindSchema,
  source: z.enum(["recording", "import"]),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  status: TranscriptionStatusSchema,
  error: z.string().nullable(),
  /** The job currently working on this meeting, for GET /jobs/:id/events. */
  jobId: z.string().nullable(),
  audioUrl: z.string().nullable(),
  notebookId: z.string().nullable(),
  commitmentCount: z.number().int(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

/** SSE payload of GET /jobs/:id/events. */
export const JobEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(["queued", "running", "done", "failed"]),
  progress: z.number().min(0).max(1).nullable(),
  note: z.string().nullable(),
  error: z.string().nullable(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

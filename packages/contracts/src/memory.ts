import { z } from "zod";

/**
 * Where a chunk lives inside its source. Every chunk also stores charStart/charEnd into
 * documents.raw_text, so a citation always resolves to an exact span. Spec: PLAN §4.3.
 */
export const AnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pdf_page"), page: z.number().int().positive() }),
  z.object({ kind: z.literal("text") }),
  z.object({
    kind: z.literal("transcript"),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("message"), messageId: z.string(), threadId: z.string().optional() }),
  z.object({ kind: z.literal("notion_block"), blockId: z.string(), pageId: z.string() }),
  z.object({
    kind: z.literal("github"),
    type: z.enum(["issue", "pr", "comment"]),
    number: z.number().int(),
    commentId: z.string().optional(),
  }),
  z.object({ kind: z.literal("event"), eventId: z.string() }),
  z.object({ kind: z.literal("row"), rowId: z.string() }),
]);
export type Anchor = z.infer<typeof AnchorSchema>;

export const SourceTypeSchema = z.enum([
  "pdf",
  "docx",
  "markdown",
  "text",
  "html",
  "transcript",
  "meeting",
  "email",
  "notion",
  "github",
  "calendar",
  // Phase 7: Linear, Todoist and Asana tasks; Slack channels; PostHog insight snapshots.
  "task",
  "chat",
  "analytics",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** Retrieval scope. A union of notebooks is a cross-notebook search. Spec: memory.md. */
export const ScopeSchema = z.object({
  notebookIds: z.array(z.string()).optional(),
  connectorIds: z.array(z.string()).optional(),
  sourceTypes: z.array(SourceTypeSchema).optional(),
  entityIds: z.array(z.string()).optional(),
  documentIds: z.array(z.string()).optional(),
  dateFrom: z.number().int().optional(),
  dateTo: z.number().int().optional(),
  localOnly: z.boolean().optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const CitationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  anchor: AnchorSchema,
  quote: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

import { z } from "zod";

export const TaskSchema = z.enum([
  "tag",
  "title",
  "classify",
  "chunk_summary",
  "doc_summary",
  "meeting_summary",
  "extract",
  "chat",
  "verify",
  "judge",
  "quiz_gen",
  "quiz_grade",
  "flashcard_gen",
  "mindmap",
  "routine",
  "draft",
  "propose_actions",
  "style",
  "memory_suggest",
]);
export type Task = z.infer<typeof TaskSchema>;

/** How an answer was produced; the UI shows it as a chip ("local · qwen… (fallback: JSON invalid twice)"). */
export const PathInfoSchema = z.object({
  provider: z.string(),
  model: z.string(),
  local: z.boolean(),
  attempts: z.number().int(),
  fallbackReason: z.string().optional(),
});
export type PathInfo = z.infer<typeof PathInfoSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const Origin = z.union([
  z.literal("user_turn"),
  z.literal("system"),
  z.string().regex(/^routine:.+$/),
]);
export type Origin = z.infer<typeof Origin>;

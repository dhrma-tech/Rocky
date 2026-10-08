import { z } from "zod";
import { ReviewLevelSchema, RiskSchema } from "./actions.ts";

/**
 * The typed event stream (UI spec "Agent UI", roadmap A10). Every screen that shows work in
 * flight renders from these: the pebble, the status chip, the timeline, receipts and
 * notifications. Events are stored in order and replayable by `seq`.
 */

/** The eleven agent states (UI spec "The eleven states"). One value drives every indicator. */
export const AgentStateSchema = z.enum([
  "thinking",
  "working",
  "browsing",
  "using_tool",
  "needs_approval",
  "completed",
  "failed",
  "waiting",
  "background",
  "learned",
  "remembers",
]);
export type AgentState = z.infer<typeof AgentStateSchema>;

/** What a "run" is in today's engine (docs/DECISIONS.md D-017): no general agent loop. */
export const RunKindSchema = z.enum(["ask", "routine", "job", "sync", "action"]);
export type RunKind = z.infer<typeof RunKindSchema>;

const Base = {
  seq: z.number().int().positive(),
  at: z.number().int(),
  /** The run this event belongs to (job id, action id, connector run id, ask id), if any. */
  runId: z.string().nullable(),
};

export const MessageEventSchema = z.object({
  ...Base,
  kind: z.literal("message"),
  role: z.enum(["user", "rocky"]),
  text: z.string(),
});

export const StatusEventSchema = z.object({
  ...Base,
  kind: z.literal("status"),
  state: AgentStateSchema,
  runKind: RunKindSchema,
  /** "Syncing Gmail", "Routine: Monday brief". */
  title: z.string(),
  /** The one live line: what is happening now, in words. */
  line: z.string().optional(),
  step: z
    .object({ n: z.number().int().positive(), of: z.number().int().positive().optional() })
    .optional(),
});

/** The one-line, checkable result of an action: tool, verb, count, what did not happen. */
export const ReceiptEventSchema = z.object({
  ...Base,
  kind: z.literal("receipt"),
  tool: z.string(),
  verb: z.string(),
  count: z.number().int().nonnegative(),
  unit: z.string(),
  /** "0 changed", "not sent". Shown after the count. */
  notDone: z.string().optional(),
  subject: z.object({ type: z.string(), id: z.string() }).optional(),
});

export const ApprovalEventSchema = z.object({
  ...Base,
  kind: z.literal("approval"),
  actionId: z.string(),
  change: z.enum(["proposed", "edited", "approved", "revoked", "rejected", "executed", "failed"]),
  title: z.string(),
  risk: RiskSchema,
  review: ReviewLevelSchema,
});

export const MemoryEventSchema = z.object({
  ...Base,
  kind: z.literal("memory"),
  change: z.enum(["learned", "used", "forgotten"]),
  text: z.string(),
  source: z.string().optional(),
});

/** Failure, in the spec's three lines: what happened, what Rocky tried, what you can do. */
export const ErrorEventSchema = z.object({
  ...Base,
  kind: z.literal("error"),
  code: z.string(),
  message: z.string(),
  tried: z.string().optional(),
  youCan: z.string().optional(),
});

export const RockyEventSchema = z.discriminatedUnion("kind", [
  MessageEventSchema,
  StatusEventSchema,
  ReceiptEventSchema,
  ApprovalEventSchema,
  MemoryEventSchema,
  ErrorEventSchema,
]);
export type RockyEvent = z.infer<typeof RockyEventSchema>;
export type RockyEventKind = RockyEvent["kind"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What emitters pass: the store assigns `seq` and, unless given, `at`. */
export type RockyEventInput = DistributiveOmit<RockyEvent, "seq" | "at"> & { at?: number };

export const EventsPageSchema = z.object({
  events: z.array(RockyEventSchema),
  /** The highest seq returned, or the `after` cursor when nothing new. */
  last: z.number().int().nonnegative(),
});
export type EventsPage = z.infer<typeof EventsPageSchema>;

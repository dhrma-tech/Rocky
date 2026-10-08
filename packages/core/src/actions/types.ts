import type { ActionClass, ActionDescription, Risk } from "@rocky/contracts";
import type { ZodType } from "zod";

export interface ExecContext {
  /** Passed to the remote API where supported; otherwise used for search-before-create. */
  idempotencyKey: string;
  signal: AbortSignal;
}

/** Declared by connectors (specs/actions.md). `execute` is reachable only through ActionService. */
export interface ActionDefinition<P = unknown> {
  type: string;
  title: string;
  connectorId?: string;
  /** Validated at propose, edit and execute. */
  schema: ZodType<P>;
  /** Fixed risk, or computed from the payload (e.g. calendar events with attendees are high). */
  risk: Risk | ((p: P) => Risk);
  /** Defaults to "write". */
  actionClass?: ActionClass | ((p: P) => ActionClass);
  describe(p: P): ActionDescription;
  execute(p: P, ctx: ExecContext): Promise<unknown>;
}

/** The definition as everyone except ActionService sees it: no executor. */
export type PublicActionDefinition<P = unknown> = Omit<ActionDefinition<P>, "execute">;

export type ActionErrorCode =
  | "UNKNOWN_TYPE"
  | "NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "HASH_MISMATCH"
  | "INVALID_PAYLOAD"
  | "ORIGIN_FORBIDDEN"
  | "NO_CITATION"
  | "TYPE_NOT_ALLOWED"
  | "REVIEW_REQUIRED";

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

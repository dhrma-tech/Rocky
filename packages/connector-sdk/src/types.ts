import type { Anchor, ConnectorHealth, Risk } from "@rocky/contracts";
import type { ZodType } from "zod";
import type { Http } from "./http.ts";

/**
 * Connector SDK (docs/specs/connectors.md). Built-in connectors and plugins use exactly this API.
 * Connectors never get a store handle: they yield normalized documents and the core persists them.
 */

export interface SecretSpec {
  /** Short name; stored in the keychain as `<connector id or authGroup>.<name>`. */
  name: string;
  label: string;
  description?: string;
}

/** A connector's own secrets only; other connectors' keys are unreachable. */
export interface ScopedSecrets {
  get(name: string): string | null;
  set(name: string, value: string): void;
}

export type Logger = (msg: string) => void;

export interface AnchorUnit {
  anchor: Anchor;
  text: string;
  /** A unit may carry its own heading (e.g. "Comment by octocat"). */
  heading?: string;
}

export interface SourceDocument {
  externalId: string;
  /** One of the contracts SourceType values (github, notion, email, calendar, pdf, markdown, …). */
  sourceType: string;
  title: string;
  /** Deep link that opens the item in its app. */
  uri?: string;
  author?: { name?: string; email?: string };
  createdAt: number;
  updatedAt: number;
  mime: string;
  body:
    | { kind: "text"; text?: string; units?: AnchorUnit[] }
    | { kind: "binary"; filename: string; fetch(): Promise<Uint8Array> };
  meta?: Record<string, unknown>;
}

export interface DocumentBatch<Cur> {
  documents: SourceDocument[];
  /** Tombstones from the source: deleted, trashed or unshared items. */
  deletedExternalIds?: string[];
  /** Committed only after this batch is persisted, so a crash re-fetches at most one batch. */
  cursor: Cur;
  /** True when the connector restarted from scratch (e.g. an expired history id). */
  fullResync?: boolean;
  /**
   * A full sweep's complete list of items that still exist. The core deletes this connector's
   * documents that are not in it (pages unshared or trashed since the last sweep).
   */
  presentExternalIds?: string[];
}

export interface SyncContext<Cfg> {
  config: Cfg;
  http: Http;
  secrets: ScopedSecrets;
  log: Logger;
  signal: AbortSignal;
  /** Start of the backfill window (ms UTC) for a first sync. */
  since: number;
  /** Access token for connectors in an OAuth auth group (Google); refreshed by the core. */
  accessToken?: () => Promise<string>;
}

export interface ExecContext {
  idempotencyKey: string;
  /** The connector's current (validated) config, e.g. the repos a write may target. */
  config: unknown;
  signal: AbortSignal;
  http: Http;
  secrets: ScopedSecrets;
  accessToken?: () => Promise<string>;
}

export interface HealthContext<Cfg> {
  config: Cfg;
  http: Http;
  secrets: ScopedSecrets;
  accessToken?: () => Promise<string>;
}

/** What the approval card shows (mirrors the core ActionDescription). */
export interface ActionDescription {
  target: string;
  summary: string;
  diff?: unknown;
}

export interface ConnectorAction<P> {
  type: string;
  title: string;
  schema: ZodType<P>;
  risk: Risk | ((p: P) => Risk);
  describe(p: P): ActionDescription;
  execute(p: P, ctx: ExecContext): Promise<unknown>;
}

export interface OAuthSpec {
  /** Auth group shared by several connectors (Gmail, Calendar and Drive share "google-oauth"). */
  group: string;
  authUrl: string;
  tokenUrl: string;
  /** Scopes this connector needs; requested incrementally. */
  scopes: string[];
}

export interface Connector<Cfg = unknown, Cur = unknown> {
  id: string;
  displayName: string;
  /** "Reads", "Reads, creates issues" — shown on the connector card. */
  permissions: string;
  configSchema: ZodType<Cfg>;
  secrets: SecretSpec[];
  oauth?: OAuthSpec;
  defaultIntervalMin: number;
  readOnlyCapable?: boolean;
  sync(ctx: SyncContext<Cfg>, cursor: Cur | undefined): AsyncIterable<DocumentBatch<Cur>>;
  health(ctx: HealthContext<Cfg>): Promise<ConnectorHealth>;
  // biome-ignore lint/suspicious/noExplicitAny: each action has its own payload type.
  actions?(): ConnectorAction<any>[];
}

/** Thrown when stored credentials are rejected (revoked token, Google invalid_grant). */
export class AuthExpired extends Error {
  readonly code = "AUTH_EXPIRED";
}

/** Thrown when a required secret or setting is missing. */
export class NotConfigured extends Error {
  readonly code = "NOT_CONFIGURED";
}

/** Major version of this SDK; plugins declare `rocky: { sdk: "^1" }`. */
export const SDK_MAJOR = 1;

import { z } from "zod";

/** Spec: docs/specs/connectors.md, docs/specs/ui.md (Connectors screen). */

export const HealthStatusSchema = z.enum(["ok", "degraded", "error", "auth_expired"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ConnectorHealthSchema = z.object({
  status: HealthStatusSchema,
  message: z.string(),
  /** e.g. a GitHub PAT expiry; health warns ahead of it. */
  tokenExpiresAt: z.number().int().optional(),
  /** Who the credentials belong to ("octocat", "you@gmail.com"). */
  account: z.string().optional(),
});
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;

/** What the connector card shows (DESIGN §5.7): Connected, Syncing, Needs reconnect, Error, Not set up. */
export const ConnectorStatusSchema = z.enum([
  "connected",
  "syncing",
  "needs_reconnect",
  "error",
  "not_configured",
  "disabled",
]);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const ConnectorRunSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  status: z.enum(["running", "ok", "error"]),
  added: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  requests: z.number().int(),
  full: z.boolean(),
  error: z.string().nullable(),
});
export type ConnectorRun = z.infer<typeof ConnectorRunSchema>;

export const SecretSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Stored already (the value is never returned). */
  stored: z.boolean(),
});

/** Honest support level (roadmap M3). "supported" only once the nightly live test passes. */
export const ConnectorTierSchema = z.enum(["supported", "experimental", "link-only"]);
export type ConnectorTier = z.infer<typeof ConnectorTierSchema>;

export const ConnectorCatalogEntrySchema = z.object({
  kind: z.string(),
  displayName: z.string(),
  permissions: z.string(),
  /** JSON Schema of the non-secret config (repos, backfill days, …). */
  configSchema: z.unknown(),
  secrets: z.array(SecretSpecSchema),
  /** OAuth group ("google-oauth") when the connector signs in through a browser. */
  oauthGroup: z.string().nullable(),
  actions: z.array(z.object({ type: z.string(), title: z.string() })),
  defaultIntervalMin: z.number().int(),
  plugin: z.boolean(),
  tier: ConnectorTierSchema,
});
export type ConnectorCatalogEntry = z.infer<typeof ConnectorCatalogEntrySchema>;

export const ConnectorSchema = z.object({
  id: z.string(),
  kind: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  readOnly: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  status: ConnectorStatusSchema,
  message: z.string().nullable(),
  tier: ConnectorTierSchema,
  intervalMin: z.number().int(),
  lastSyncAt: z.number().int().nullable(),
  lastSuccessAt: z.number().int().nullable(),
  nextSyncAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** The stored cursor, shown in the detail drawer. */
  cursor: z.unknown(),
  documentCount: z.number().int(),
  lastRun: ConnectorRunSchema.nullable(),
  createdAt: z.number().int(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const ConnectorCreateSchema = z
  .object({
    kind: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()).default({}),
    intervalMin: z.number().int().min(5).max(1440).optional(),
  })
  .strict();
export type ConnectorCreate = z.infer<typeof ConnectorCreateSchema>;

export const ConnectorUpdateSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
    intervalMin: z.number().int().min(5).max(1440),
  })
  .partial()
  .strict();
export type ConnectorUpdate = z.infer<typeof ConnectorUpdateSchema>;

/** POST /actions: the user proposes an action (e.g. "Create GitHub issue" from an answer). */
export const ProposeRequestSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown(),
    citations: z.array(z.unknown()).min(1),
  })
  .strict();

import {
  AuthExpired,
  type Connector,
  createHttp,
  type Http,
  HttpError,
  type LoopbackSession,
  NotConfigured,
  refreshAccessToken,
  type ScopedSecrets,
  type SourceDocument,
  startLoopbackAuth,
} from "@rocky/connector-sdk";
import type {
  ConnectorCatalogEntry,
  ConnectorHealth,
  ConnectorRun,
  ConnectorStatus,
  Connector as ConnectorView,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { z } from "zod";
import type { ActionRegistry } from "../actions/registry.ts";
import { appendAudit } from "../audit/append.ts";
import { deleteData } from "../deletion/service.ts";
import { EMBED_JOB } from "../ingest/embed-job.ts";
import { upsertDocument } from "../ingest/upsert.ts";
import { enqueue } from "../jobs/queue.ts";
import { CONNECTOR_SECRET_RE, type SecretName, type SecretStore } from "../secrets/keychain.ts";
import { putBlob } from "../store/blobs.ts";
import type { Db } from "../store/db.ts";
import { toParsedDoc } from "./to-parsed.ts";

/**
 * ConnectorService (connectors.md "Runtime guarantees"): owns connector rows, scoped secrets,
 * Google sign-in, and syncs. A sync persists each batch and its cursor in one transaction, so a
 * crash re-fetches at most one batch. One sync per connector at a time (lock in connector_state).
 * Syncs run on their own lane, never in the job queue, so a long backfill never blocks embedding.
 */

export class ConnectorError extends Error {
  readonly code: "NOT_FOUND" | "BAD_REQUEST" | "ILLEGAL_TRANSITION";
  constructor(code: ConnectorError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const LOCK_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 6 * 3600_000;
const DEFAULT_BACKFILL_DAYS = 90;
const BackfillSchema = z.object({ backfillDays: z.number().int().min(1).max(3650).optional() });

/** Google's downloaded "Desktop app" client JSON. */
const ClientJsonSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
});

export class ConnectorRegistry {
  private readonly defs = new Map<string, { def: Connector; plugin: boolean }>();
  register(def: Connector, opts: { plugin?: boolean } = {}): void {
    if (this.defs.has(def.id)) throw new Error(`Connector "${def.id}" is already registered`);
    this.defs.set(def.id, { def, plugin: Boolean(opts.plugin) });
  }
  get(kind: string): Connector | undefined {
    return this.defs.get(kind)?.def;
  }
  isPlugin(kind: string): boolean {
    return this.defs.get(kind)?.plugin ?? false;
  }
  list(): Connector[] {
    return [...this.defs.values()].map((d) => d.def);
  }
}

interface Row {
  id: string;
  kind: string;
  display_name: string;
  enabled: number;
  read_only: number;
  config: string;
  created_at: number;
  interval_min: number | null;
  cursor: string | null;
  last_sync_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  backoff_until: number | null;
  next_sync_at: number | null;
  lock_until: number | null;
  last_status: string | null;
  health_message: string | null;
  consecutive_failures: number | null;
}

export interface ConnectorServiceDeps {
  db: Db;
  secrets: SecretStore;
  registry: ConnectorRegistry;
  actions: ActionRegistry;
  blobsDir: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
  /** Concurrent syncs across connectors. */
  maxConcurrent?: number;
}

export class ConnectorService {
  private readonly d: ConnectorServiceDeps;
  private readonly running = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly oauth = new Map<string, LoopbackSession>();
  private readonly registeredActions = new Set<string>();

  constructor(deps: ConnectorServiceDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private log(msg: string) {
    this.d.log?.(msg);
  }

  // --- definitions and secrets ---

  private def(kind: string): Connector {
    const def = this.d.registry.get(kind);
    if (!def) throw new ConnectorError("NOT_FOUND", `Unknown connector "${kind}"`);
    return def;
  }

  /** Secrets live under the connector id, or its OAuth group (Gmail/Calendar/Drive share google-oauth). */
  private prefix(def: Connector): string {
    return def.oauth?.group ?? def.id;
  }

  /** The connector sees only its own names; anything else throws. */
  scopedSecrets(kind: string): ScopedSecrets {
    const def = this.def(kind);
    const prefix = this.prefix(def);
    const key = (name: string): SecretName => {
      const k = `${prefix}.${name}`;
      if (!CONNECTOR_SECRET_RE.test(k))
        throw new ConnectorError("BAD_REQUEST", `Invalid secret name ${name}`);
      return k as SecretName;
    };
    return {
      get: (name) => this.d.secrets.get(key(name)),
      set: (name, value) => this.d.secrets.set(key(name), value),
    };
  }

  setSecret(kind: string, name: string, value: string): void {
    const def = this.def(kind);
    if (!def.secrets.some((s) => s.name === name))
      throw new ConnectorError("BAD_REQUEST", `${def.displayName} has no secret "${name}"`);
    this.scopedSecrets(kind).set(name, value);
    appendAudit(this.d.db, {
      eventType: "connector_secret_set",
      actor: "user",
      subjectType: "connector",
      subjectId: kind,
      meta: { name },
    });
  }

  /** Imports the Google client JSON (Desktop app) into the group's keychain entry. */
  setOAuthClient(group: string, json: string): void {
    const parsed = ClientJsonSchema.safeParse(
      (() => {
        try {
          return JSON.parse(json);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success)
      throw new ConnectorError(
        "BAD_REQUEST",
        'Not a Google "Desktop app" client file: expected {"installed": {"client_id", "client_secret"}}.',
      );
    if (!this.d.registry.list().some((c) => c.oauth?.group === group))
      throw new ConnectorError("NOT_FOUND", `No connector uses sign-in group "${group}"`);
    this.d.secrets.set(`${group}.client` as SecretName, JSON.stringify(parsed.data.installed));
  }

  private http(kind: string): Http {
    return createHttp({
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
      log: (m) => this.log(`[${kind}] ${m}`),
      concurrency: 4,
    });
  }

  private oauthClient(group: string): { client_id: string; client_secret: string } | null {
    const raw = this.d.secrets.get(`${group}.client` as SecretName);
    return raw ? (JSON.parse(raw) as { client_id: string; client_secret: string }) : null;
  }

  /** A fresh access token for an OAuth connector; cached until a minute before expiry. */
  private accessToken(def: Connector): (() => Promise<string>) | undefined {
    const spec = def.oauth;
    if (!spec) return undefined;
    return async () => {
      const cached = this.tokens.get(spec.group);
      if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
      const client = this.oauthClient(spec.group);
      const refresh = this.d.secrets.get(`${spec.group}.refresh` as SecretName);
      if (!client || !refresh)
        throw new AuthExpired(
          `${def.displayName} is not signed in. Connect it on the Connectors page.`,
        );
      const t = await refreshAccessToken({
        clientId: client.client_id,
        clientSecret: client.client_secret,
        refreshToken: refresh,
        tokenUrl: spec.tokenUrl,
        ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
      });
      this.tokens.set(spec.group, { token: t.accessToken, expiresAt: t.expiresAt });
      return t.accessToken;
    };
  }

  /** Missing setup, if any: a required secret, the OAuth client file, or the sign-in. */
  private missingSetup(def: Connector): string | null {
    if (def.oauth) {
      if (!this.oauthClient(def.oauth.group))
        return "Import the Google client file to set up sign-in.";
      if (!this.d.secrets.has(`${def.oauth.group}.refresh` as SecretName))
        return "Sign in with Google.";
      return null;
    }
    const s = this.scopedSecrets(def.id);
    const missing = def.secrets.find((x) => !s.get(x.name));
    return missing ? `Add the ${missing.label}.` : null;
  }

  // --- Google sign-in ---

  /** Starts the loopback sign-in; returns the URL the browser opens. Requests every scope the group's connectors need. */
  async startOAuth(kind: string): Promise<{ authUrl: string }> {
    const def = this.def(kind);
    const spec = def.oauth;
    if (!spec)
      throw new ConnectorError("BAD_REQUEST", `${def.displayName} doesn't use browser sign-in`);
    const client = this.oauthClient(spec.group);
    if (!client) throw new ConnectorError("BAD_REQUEST", "Import the Google client file first.");
    this.oauth.get(spec.group)?.close();
    const added = new Set(this.rows().map((r) => r.kind));
    const scopes = [
      ...new Set(
        this.d.registry
          .list()
          .filter((c) => c.oauth?.group === spec.group && (added.has(c.id) || c.id === kind))
          .flatMap((c) => c.oauth?.scopes ?? []),
      ),
    ];
    const session = await startLoopbackAuth({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      scopes,
      authUrl: spec.authUrl,
      tokenUrl: spec.tokenUrl,
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
    });
    this.oauth.set(spec.group, session);
    session.done
      .then((t) => {
        // Google returns a refresh token on consent; keep the old one if this grant had none.
        if (t.refresh_token)
          this.d.secrets.set(`${spec.group}.refresh` as SecretName, t.refresh_token);
        this.tokens.set(spec.group, {
          token: t.access_token,
          expiresAt: this.now() + t.expires_in * 1000,
        });
        appendAudit(this.d.db, {
          eventType: "connector_signed_in",
          actor: "user",
          subjectType: "connector",
          subjectId: spec.group,
          meta: { scopes },
        });
        for (const r of this.rows())
          if (this.d.registry.get(r.kind)?.oauth?.group === spec.group) {
            this.d.db
              .prepare(
                "update connector_state set last_status = null, health_message = null, next_sync_at = ? where connector_id = ?",
              )
              .run(this.now(), r.id);
          }
      })
      .catch((err: unknown) => this.log(`[${spec.group}] sign-in failed: ${String(err)}`))
      .finally(() => this.oauth.delete(spec.group));
    return { authUrl: session.authUrl };
  }

  // --- rows and views ---

  private rows(): Row[] {
    return this.d.db
      .prepare(
        `select c.*, s.cursor, s.last_sync_at, s.last_success_at, s.last_error, s.backoff_until, s.next_sync_at,
                s.lock_until, s.last_status, s.health_message, s.consecutive_failures
         from connectors c left join connector_state s on s.connector_id = c.id order by c.created_at`,
      )
      .all() as Row[];
  }

  private row(id: string): Row {
    const r = this.rows().find((x) => x.id === id);
    if (!r) throw new ConnectorError("NOT_FOUND", "Connector not found");
    return r;
  }

  private status(
    r: Row,
    def: Connector | undefined,
  ): { status: ConnectorStatus; message: string | null } {
    if (!def) return { status: "error", message: "This connector's plugin is not loaded." };
    if (!r.enabled) return { status: "disabled", message: null };
    if (this.running.has(r.id)) return { status: "syncing", message: null };
    if (r.last_status === "auth_expired")
      return { status: "needs_reconnect", message: r.health_message ?? r.last_error };
    const missing = this.missingSetup(def);
    if (missing) return { status: "not_configured", message: missing };
    if ((r.consecutive_failures ?? 0) > 0 && r.last_error)
      return { status: "error", message: r.last_error };
    return { status: "connected", message: r.last_status === "degraded" ? r.health_message : null };
  }

  private view(r: Row): ConnectorView {
    const def = this.d.registry.get(r.kind);
    const lastRun = this.runs(r.id, 1)[0] ?? null;
    const docs = (
      this.d.db.prepare("select count(*) as n from documents where connector_id = ?").get(r.id) as {
        n: number;
      }
    ).n;
    return {
      id: r.id,
      kind: r.kind,
      displayName: r.display_name,
      enabled: r.enabled === 1,
      readOnly: r.read_only === 1,
      config: JSON.parse(r.config) as Record<string, unknown>,
      ...this.status(r, def),
      intervalMin: r.interval_min ?? def?.defaultIntervalMin ?? 15,
      lastSyncAt: r.last_sync_at,
      lastSuccessAt: r.last_success_at,
      nextSyncAt: r.next_sync_at,
      lastError: r.last_error,
      cursor: r.cursor ? (JSON.parse(r.cursor) as unknown) : null,
      documentCount: docs,
      lastRun,
      createdAt: r.created_at,
    };
  }

  list(): ConnectorView[] {
    return this.rows().map((r) => this.view(r));
  }

  get(id: string): ConnectorView {
    return this.view(this.row(id));
  }

  catalog(): ConnectorCatalogEntry[] {
    return this.d.registry.list().map((def) => {
      const s = this.scopedSecrets(def.id);
      return {
        kind: def.id,
        displayName: def.displayName,
        permissions: def.permissions,
        configSchema: z.toJSONSchema(def.configSchema, { unrepresentable: "any" }),
        secrets: def.secrets.map((x) => ({ ...x, stored: s.get(x.name) !== null })),
        oauthGroup: def.oauth?.group ?? null,
        actions: (def.actions?.() ?? []).map((a) => ({ type: a.type, title: a.title })),
        defaultIntervalMin: def.defaultIntervalMin,
        plugin: this.d.registry.isPlugin(def.id),
      };
    });
  }

  runs(id: string, limit = 20): ConnectorRun[] {
    const rows = this.d.db
      .prepare(
        "select * from connector_runs where connector_id = ? order by started_at desc limit ?",
      )
      .all(id, limit) as {
      id: string;
      connector_id: string;
      started_at: number;
      finished_at: number | null;
      status: ConnectorRun["status"];
      added: number;
      updated: number;
      deleted: number;
      requests: number;
      full: number;
      error: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      connectorId: r.connector_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      added: r.added,
      updated: r.updated,
      deleted: r.deleted,
      requests: r.requests,
      full: r.full === 1,
      error: r.error,
    }));
  }

  // --- lifecycle ---

  add(kind: string, config: Record<string, unknown> = {}, intervalMin?: number): ConnectorView {
    const def = this.def(kind);
    const cfg = def.configSchema.safeParse(config);
    if (!cfg.success) throw new ConnectorError("BAD_REQUEST", z.prettifyError(cfg.error));
    if (this.d.db.prepare("select 1 from connectors where id = ?").get(kind))
      throw new ConnectorError("ILLEGAL_TRANSITION", `${def.displayName} is already added`);
    const now = this.now();
    // Connectors with write actions start writable (writes still need approval); others read-only.
    const readOnly = def.actions?.().length ? 0 : 1;
    this.d.db.transaction(() => {
      this.d.db
        .prepare(
          "insert into connectors (id, kind, display_name, enabled, read_only, config, created_at, interval_min) values (?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .run(
          kind,
          kind,
          def.displayName,
          readOnly,
          JSON.stringify(cfg.data),
          now,
          intervalMin ?? null,
        );
      this.d.db
        .prepare(
          "insert into connector_state (connector_id, next_sync_at, consecutive_failures) values (?, ?, 0)",
        )
        .run(kind, now);
      appendAudit(this.d.db, {
        eventType: "connector_added",
        actor: "user",
        subjectType: "connector",
        subjectId: kind,
      });
    })();
    this.registerActions();
    return this.get(kind);
  }

  update(
    id: string,
    patch: { config?: Record<string, unknown>; enabled?: boolean; intervalMin?: number },
  ): ConnectorView {
    const r = this.row(id);
    const def = this.def(r.kind);
    if (patch.config) {
      const cfg = def.configSchema.safeParse(patch.config);
      if (!cfg.success) throw new ConnectorError("BAD_REQUEST", z.prettifyError(cfg.error));
      this.d.db
        .prepare("update connectors set config = ? where id = ?")
        .run(JSON.stringify(cfg.data), id);
    }
    if (patch.enabled !== undefined)
      this.d.db
        .prepare("update connectors set enabled = ? where id = ?")
        .run(patch.enabled ? 1 : 0, id);
    if (patch.intervalMin !== undefined)
      this.d.db
        .prepare("update connectors set interval_min = ? where id = ?")
        .run(patch.intervalMin, id);
    return this.get(id);
  }

  /**
   * Disconnects. With `purge`, every document it synced goes through the DeletionService. Its
   * secrets are removed unless another connector shares them (the Google group).
   */
  remove(id: string, opts: { purge?: boolean } = {}): { purged: number } {
    const r = this.row(id);
    const def = this.d.registry.get(r.kind);
    let purged = 0;
    if (opts.purge) purged = deleteData(this.d.db, this.d.blobsDir, { connectorId: id }).documents;
    else this.d.db.prepare("delete from connectors where id = ?").run(id);
    appendAudit(this.d.db, {
      eventType: "connector_removed",
      actor: "user",
      subjectType: "connector",
      subjectId: id,
      meta: { purged },
    });
    if (def) {
      const prefix = this.prefix(def);
      const shared = this.rows().some((x) => {
        const other = this.d.registry.get(x.kind);
        return other && this.prefix(other) === prefix;
      });
      if (!shared)
        for (const name of this.d.secrets.list())
          if (name.startsWith(`${prefix}.`)) this.d.secrets.delete(name as SecretName);
      if (!shared) this.tokens.delete(prefix);
    }
    return { purged };
  }

  async test(id: string): Promise<ConnectorHealth> {
    const r = this.row(id);
    const def = this.def(r.kind);
    let h: ConnectorHealth;
    const missing = this.missingSetup(def);
    if (missing) h = { status: "error", message: missing };
    else
      try {
        const token = this.accessToken(def);
        h = await def.health({
          config: JSON.parse(r.config),
          http: this.http(def.id),
          secrets: this.scopedSecrets(def.id),
          ...(token ? { accessToken: token } : {}),
        });
      } catch (err) {
        h = {
          status: isAuthError(err) ? "auth_expired" : "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    this.d.db
      .prepare(
        "update connector_state set last_status = ?, health_message = ? where connector_id = ?",
      )
      .run(h.status, h.message, id);
    return h;
  }

  // --- actions ---

  /**
   * Registers each added connector's actions with the ActionRegistry. The executor gets http and
   * this connector's secrets; it still only ever runs through ActionService.execute.
   */
  registerActions(): void {
    for (const r of this.rows()) {
      const def = this.d.registry.get(r.kind);
      for (const a of def?.actions?.() ?? []) {
        if (this.registeredActions.has(a.type)) continue;
        this.registeredActions.add(a.type);
        const kind = r.kind;
        this.d.actions.register({
          type: a.type,
          title: a.title,
          connectorId: kind,
          schema: a.schema,
          risk: a.risk,
          describe: (p) => a.describe(p),
          execute: async (p, ctx) => {
            const cur = this.d.db
              .prepare("select enabled, read_only from connectors where id = ?")
              .get(kind) as { enabled: number; read_only: number } | undefined;
            if (!cur?.enabled)
              throw new Error(`${def?.displayName ?? kind} is disconnected or disabled`);
            if (cur.read_only) throw new Error(`${def?.displayName ?? kind} is read-only`);
            const token = def ? this.accessToken(def) : undefined;
            return a.execute(p, {
              ...ctx,
              http: this.http(kind),
              secrets: this.scopedSecrets(kind),
              ...(token ? { accessToken: token } : {}),
            });
          },
        });
      }
    }
  }

  // --- sync ---

  /** Connectors due now (enabled, set up, not backing off, not running). */
  due(): string[] {
    const now = this.now();
    return this.rows()
      .filter((r) => {
        const def = this.d.registry.get(r.kind);
        return (
          def &&
          r.enabled &&
          !this.running.has(r.id) &&
          (r.next_sync_at === null || r.next_sync_at <= now) &&
          (r.backoff_until === null || r.backoff_until <= now) &&
          r.last_status !== "auth_expired" &&
          !this.missingSetup(def)
        );
      })
      .map((r) => r.id);
  }

  /** Starts a sync unless one is running; resolves when it ends. Errors are recorded, never thrown. */
  sync(id: string): Promise<void> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const p = this.runSync(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Waits for every running sync (shutdown, tests). */
  async idle(): Promise<void> {
    await Promise.all(this.running.values());
  }

  private async runSync(id: string): Promise<void> {
    const r = this.row(id);
    const def = this.def(r.kind);
    const now = this.now();
    const locked = this.d.db
      .prepare(
        "update connector_state set lock_until = ? where connector_id = ? and (lock_until is null or lock_until < ?)",
      )
      .run(now + LOCK_MS, id, now).changes;
    if (!locked) return; // Another process (CLI vs daemon) is syncing it.

    const runId = ulid(now);
    this.d.db
      .prepare(
        "insert into connector_runs (id, connector_id, started_at, status) values (?, ?, ?, 'running')",
      )
      .run(runId, id, now);
    const counts = { added: 0, updated: 0, deleted: 0, full: 0 };
    const http = this.http(def.id);
    const config = JSON.parse(r.config) as Record<string, unknown>;
    const backfill = BackfillSchema.catch({}).parse(config).backfillDays ?? DEFAULT_BACKFILL_DAYS;
    const controller = new AbortController();
    try {
      const missing = this.missingSetup(def);
      if (missing) throw new NotConfigured(missing);
      const cursor = r.cursor ? (JSON.parse(r.cursor) as unknown) : undefined;
      const token = this.accessToken(def);
      for await (const batch of def.sync(
        {
          config,
          http,
          secrets: this.scopedSecrets(def.id),
          log: (m) => this.log(`[${id}] ${m}`),
          signal: controller.signal,
          since: now - backfill * 86_400_000,
          ...(token ? { accessToken: token } : {}),
        },
        cursor,
      )) {
        if (batch.fullResync) counts.full = 1;
        // Fetch and parse outside the transaction (network, CPU); persist the batch atomically.
        const prepared: ({ doc: SourceDocument } & Awaited<ReturnType<typeof toParsedDoc>>)[] = [];
        for (const doc of batch.documents) {
          try {
            prepared.push({ doc, ...(await toParsedDoc(doc)) });
          } catch (err) {
            this.log(`[${id}] skipped ${doc.externalId}: ${String(err)}`);
          }
        }
        this.d.db.transaction(() => {
          for (const p of prepared) {
            const blobHash = p.bytes ? putBlob(this.d.blobsDir, p.bytes) : undefined;
            const res = upsertDocument(this.d.db, {
              parsed: p.parsed,
              connectorId: id,
              externalId: p.doc.externalId,
              mime: p.doc.mime,
              createdAt: p.doc.createdAt,
              updatedAt: p.doc.updatedAt,
              ...(p.doc.uri ? { uri: p.doc.uri } : {}),
              ...(blobHash ? { blobHash } : {}),
              meta: { ...(p.doc.meta ?? {}), ...(p.doc.author ? { author: p.doc.author } : {}) },
            });
            if (res.status === "created") counts.added++;
            if (res.status === "updated") counts.updated++;
            if (res.status !== "unchanged")
              enqueue(this.d.db, EMBED_JOB, { documentId: res.documentId }, { priority: 1 });
          }
        })();
        // Tombstones go through the DeletionService (its own transaction, then blob files).
        const ids = (batch.deletedExternalIds ?? []).flatMap((ext) => {
          const row = this.d.db
            .prepare("select id from documents where connector_id = ? and external_id = ?")
            .get(id, ext) as { id: string } | undefined;
          return row ? [row.id] : [];
        });
        if (ids.length)
          counts.deleted += deleteData(this.d.db, this.d.blobsDir, { documentIds: ids }).documents;
        // The cursor moves only after the batch is persisted: a crash re-fetches at most this
        // batch, and replaying it is idempotent (unchanged content is skipped).
        this.d.db
          .prepare("update connector_state set cursor = ? where connector_id = ?")
          .run(JSON.stringify(batch.cursor ?? null), id);
      }
      const end = this.now();
      const interval = (r.interval_min ?? def.defaultIntervalMin) * 60_000;
      this.d.db.transaction(() => {
        this.d.db
          .prepare(
            "update connector_runs set status = 'ok', finished_at = ?, added = ?, updated = ?, deleted = ?, requests = ?, full = ? where id = ?",
          )
          .run(
            end,
            counts.added,
            counts.updated,
            counts.deleted,
            http.requests,
            counts.full,
            runId,
          );
        this.d.db
          .prepare(
            `update connector_state set last_sync_at = ?, last_success_at = ?, last_error = null, backoff_until = null,
               consecutive_failures = 0, last_status = case when last_status = 'degraded' then last_status else 'ok' end,
               next_sync_at = ?, lock_until = null where connector_id = ?`,
          )
          .run(end, end, end + interval, id);
      })();
      this.log(
        `[${id}] synced: +${counts.added} ~${counts.updated} -${counts.deleted} (${http.requests} requests)`,
      );
    } catch (err) {
      controller.abort();
      const end = this.now();
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      const failures = (r.consecutive_failures ?? 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1));
      const status = isAuthError(err) ? "auth_expired" : "error";
      this.d.db.transaction(() => {
        this.d.db
          .prepare(
            "update connector_runs set status = 'error', finished_at = ?, error = ?, requests = ?, added = ?, updated = ?, deleted = ? where id = ?",
          )
          .run(end, msg, http.requests, counts.added, counts.updated, counts.deleted, runId);
        this.d.db
          .prepare(
            `update connector_state set last_sync_at = ?, last_error = ?, consecutive_failures = ?, backoff_until = ?,
               next_sync_at = ?, last_status = ?, health_message = ?, lock_until = null where connector_id = ?`,
          )
          .run(
            end,
            msg,
            failures,
            end + backoff,
            end + backoff,
            status,
            status === "auth_expired" ? msg : null,
            id,
          );
      })();
      this.log(`[${id}] sync failed (${status}): ${msg}`);
    }
  }
}

const isAuthError = (err: unknown) =>
  err instanceof AuthExpired ||
  (err instanceof HttpError &&
    (err.status === 401 || (err.status === 403 && /bad credentials|token/i.test(err.body))));

/**
 * Polls every minute (and at start): each due connector gets one sync. After sleep, overdue
 * connectors run once, not once per missed interval, because `next_sync_at` is simply in the past.
 */
export class ConnectorScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly service: ConnectorService;
  private readonly maxConcurrent: number;
  private readonly intervalMs: number;

  constructor(
    service: ConnectorService,
    opts: { maxConcurrent?: number; intervalMs?: number } = {},
  ) {
    this.service = service;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.service.idle();
  }

  /** Starts syncs for due connectors, up to the concurrency limit. Returns the ids started. */
  tick(): string[] {
    const running = this.service.list().filter((c) => this.service.isRunning(c.id)).length;
    const started = this.service.due().slice(0, Math.max(0, this.maxConcurrent - running));
    for (const id of started) void this.service.sync(id);
    return started;
  }
}

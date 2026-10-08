import { AuthExpired, type Connector, HttpError, NotConfigured } from "@rocky/connector-sdk";
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
import { recordEvent } from "../events/log.ts";
import type { SecretStore } from "../secrets/keychain.ts";
import type { Db } from "../store/db.ts";
import { ConnectorError } from "./errors.ts";
import { type ConnectorHost, type HostSyncStream, InProcessConnectorHost } from "./host.ts";
import { persistSourceDocuments, prepareSourceDocuments } from "./persist.ts";

export { ConnectorError };

/**
 * ConnectorService (connectors.md "Runtime guarantees"): owns connector rows, Google sign-in
 * bookkeeping, and syncs. A sync persists each batch and its cursor in one transaction, so a
 * crash re-fetches at most one batch. One sync per connector at a time (lock in connector_state).
 * Syncs run on their own lane, never in the job queue, so a long backfill never blocks embedding.
 * Connector code that needs credentials or the network runs in the ConnectorHost (roadmap I1):
 * in the daemon that is a separate process, and this service never sees a token.
 */

const LOCK_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 6 * 3600_000;
const DEFAULT_BACKFILL_DAYS = 90;
const BackfillSchema = z.object({ backfillDays: z.number().int().min(1).max(3650).optional() });

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
  registry: ConnectorRegistry;
  actions: ActionRegistry;
  blobsDir: string;
  /** Where connector code runs. Without one, an in-process host is built from `secrets`. */
  host?: ConnectorHost;
  /** Only for the in-process host (tests, tools without a daemon). */
  secrets?: SecretStore;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
  /** Concurrent syncs across connectors. */
  maxConcurrent?: number;
  /** Called after a sync that changed something (notebook rules are re-applied). */
  onSynced?: (connectorId: string) => void;
}

export class ConnectorService {
  private readonly d: ConnectorServiceDeps;
  private readonly running = new Map<string, Promise<void>>();
  private readonly registeredActions = new Set<string>();
  readonly host: ConnectorHost;

  constructor(deps: ConnectorServiceDeps) {
    this.d = deps;
    if (deps.host) this.host = deps.host;
    else {
      if (!deps.secrets) throw new Error("ConnectorService needs a host or a secret store");
      this.host = new InProcessConnectorHost({
        registry: deps.registry,
        secrets: deps.secrets,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    }
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

  async setSecret(kind: string, name: string, value: string): Promise<void> {
    const def = this.def(kind);
    if (!def.secrets.some((s) => s.name === name))
      throw new ConnectorError("BAD_REQUEST", `${def.displayName} has no secret "${name}"`);
    await this.host.setSecret(kind, name, value);
    appendAudit(this.d.db, {
      eventType: "connector_secret_set",
      actor: "user",
      subjectType: "connector",
      subjectId: kind,
      meta: { name },
    });
  }

  /** Imports the Google client JSON (Desktop app) into the group's keychain entry. */
  async setOAuthClient(group: string, json: string): Promise<void> {
    if (!this.d.registry.list().some((c) => c.oauth?.group === group))
      throw new ConnectorError("NOT_FOUND", `No connector uses sign-in group "${group}"`);
    await this.host.setOAuthClient(group, json);
  }

  /** Missing setup, if any: a required secret, the OAuth client file, or the sign-in. */
  private missingSetup(def: Connector): string | null {
    try {
      return this.host.setup(def.id).missing;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // --- Google sign-in ---

  /** Starts the loopback sign-in; returns the URL the browser opens. Requests every scope the group's connectors need. */
  async startOAuth(kind: string): Promise<{ authUrl: string }> {
    const def = this.def(kind);
    const spec = def.oauth;
    if (!spec)
      throw new ConnectorError("BAD_REQUEST", `${def.displayName} doesn't use browser sign-in`);
    const added = new Set(this.rows().map((r) => r.kind));
    const scopes = [
      ...new Set(
        this.d.registry
          .list()
          .filter((c) => c.oauth?.group === spec.group && (added.has(c.id) || c.id === kind))
          .flatMap((c) => c.oauth?.scopes ?? []),
      ),
    ];
    const { authUrl, done } = await this.host.startOAuth(kind, scopes);
    done
      .then(() => {
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
      .catch((err: unknown) => this.log(`[${spec.group}] sign-in failed: ${String(err)}`));
    return { authUrl };
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
      tier: def?.tier ?? "experimental",
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
      let stored: Record<string, boolean> = {};
      try {
        stored = this.host.setup(def.id).stored;
      } catch {
        // reported by status()
      }
      return {
        kind: def.id,
        displayName: def.displayName,
        permissions: def.permissions,
        configSchema: z.toJSONSchema(def.configSchema, { unrepresentable: "any" }),
        secrets: def.secrets.map((x) => ({ ...x, stored: stored[x.name] ?? false })),
        oauthGroup: def.oauth?.group ?? null,
        actions: (def.actions?.() ?? []).map((a) => ({ type: a.type, title: a.title })),
        defaultIntervalMin: def.defaultIntervalMin,
        plugin: this.d.registry.isPlugin(def.id),
        tier: def.tier ?? "experimental",
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
  async remove(id: string, opts: { purge?: boolean } = {}): Promise<{ purged: number }> {
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
      if (!shared) await this.host.deleteSecrets(prefix);
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
        h = await this.host.health(def.id, JSON.parse(r.config));
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
   * Registers each added connector's actions with the ActionRegistry. Schema, risk and describe
   * run here (pure code); the executor runs in the connector host, which holds the credentials.
   * It still only ever runs through ActionService.execute.
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
          ...(a.actionClass ? { actionClass: a.actionClass } : {}),
          describe: (p) => a.describe(p),
          execute: async (p, ctx) => {
            const cur = this.d.db
              .prepare("select enabled, read_only, config from connectors where id = ?")
              .get(kind) as { enabled: number; read_only: number; config: string } | undefined;
            if (!cur?.enabled)
              throw new Error(`${def?.displayName ?? kind} is disconnected or disabled`);
            if (cur.read_only) throw new Error(`${def?.displayName ?? kind} is read-only`);
            return this.host.execute(
              kind,
              a.type,
              p,
              { idempotencyKey: ctx.idempotencyKey, config: JSON.parse(cur.config) as unknown },
              ctx.signal,
            );
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
    const title = `Syncing ${def.displayName}`;
    recordEvent(this.d.db, {
      kind: "status",
      runId,
      at: now,
      state: "background",
      runKind: "sync",
      title,
      line: `Reading ${def.displayName}`,
    });
    const counts = { added: 0, updated: 0, deleted: 0, full: 0 };
    let sync: HostSyncStream | undefined;
    const config = JSON.parse(r.config) as Record<string, unknown>;
    const backfill = BackfillSchema.catch({}).parse(config).backfillDays ?? DEFAULT_BACKFILL_DAYS;
    try {
      const missing = this.missingSetup(def);
      if (missing) throw new NotConfigured(missing);
      const cursor = r.cursor ? (JSON.parse(r.cursor) as unknown) : undefined;
      const stream = this.host.sync(
        { kind: def.id, config, cursor: cursor ?? null, since: now - backfill * 86_400_000 },
        (m) => this.log(`[${id}] ${m}`),
      );
      sync = stream;
      for await (const batch of stream.batches) {
        if (batch.fullResync) counts.full = 1;
        // Fetch and parse outside the transaction (network, CPU); persist the batch atomically.
        const prepared = await prepareSourceDocuments(batch.documents, (ext, err) =>
          this.log(`[${id}] skipped ${ext}: ${String(err)}`),
        );
        const persisted = persistSourceDocuments(this.d.db, this.d.blobsDir, id, prepared);
        counts.added += persisted.added;
        counts.updated += persisted.updated;
        // Tombstones go through the DeletionService (its own transaction, then blob files).
        const gone = [...(batch.deletedExternalIds ?? [])];
        if (batch.presentExternalIds) {
          const present = new Set(batch.presentExternalIds);
          const known = this.d.db
            .prepare("select external_id from documents where connector_id = ?")
            .all(id) as { external_id: string }[];
          for (const k of known) if (!present.has(k.external_id)) gone.push(k.external_id);
        }
        const ids = gone.flatMap((ext) => {
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
            sync?.requests() ?? 0,
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
      recordEvent(this.d.db, {
        kind: "receipt",
        runId,
        at: end,
        tool: def.displayName,
        verb: "synced",
        count: counts.added + counts.updated,
        unit: "items",
        // Syncs only read: nothing in the app changed.
        notDone: `0 changed in ${def.displayName}`,
        subject: { type: "connector", id },
      });
      recordEvent(this.d.db, {
        kind: "status",
        runId,
        at: end,
        state: "completed",
        runKind: "sync",
        title,
      });
      if (counts.added + counts.updated + counts.deleted > 0) this.d.onSynced?.(id);
      this.log(
        `[${id}] synced: +${counts.added} ~${counts.updated} -${counts.deleted} (${sync?.requests() ?? 0} requests)`,
      );
    } catch (err) {
      sync?.abort();
      const end = this.now();
      const failures = (r.consecutive_failures ?? 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1));
      const raw = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      // Rate limits say so in plain words, with when Rocky tries again (roadmap A2).
      const msg = isRateLimit(err)
        ? `${def.displayName} is rate limiting Rocky. It tries again in ${Math.round(backoff / 60_000)} min. (${raw.slice(0, 300)})`
        : raw;
      const status = isAuthError(err) ? "auth_expired" : "error";
      this.d.db.transaction(() => {
        this.d.db
          .prepare(
            "update connector_runs set status = 'error', finished_at = ?, error = ?, requests = ?, added = ?, updated = ?, deleted = ? where id = ?",
          )
          .run(
            end,
            msg,
            sync?.requests() ?? 0,
            counts.added,
            counts.updated,
            counts.deleted,
            runId,
          );
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
      recordEvent(this.d.db, {
        kind: "error",
        runId,
        at: end,
        code:
          status === "auth_expired"
            ? "NEEDS_RECONNECT"
            : isRateLimit(err)
              ? "RATE_LIMITED"
              : "SYNC_FAILED",
        message: msg.slice(0, 500),
        tried: `Synced ${def.displayName}; kept everything already saved.`,
        youCan:
          status === "auth_expired"
            ? `Reconnect ${def.displayName}.`
            : `Wait for the automatic retry, or sync ${def.displayName} again.`,
      });
      recordEvent(this.d.db, {
        kind: "status",
        runId,
        at: end,
        state: "failed",
        runKind: "sync",
        title,
      });
      this.log(`[${id}] sync failed (${status}): ${msg}`);
    }
  }
}

const isRateLimit = (err: unknown) =>
  err instanceof HttpError &&
  (err.status === 429 || (err.status === 403 && /rate limit|secondary rate/i.test(err.body)));

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

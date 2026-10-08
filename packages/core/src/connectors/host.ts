import {
  AuthExpired,
  type Connector,
  createHttp,
  type DocumentBatch,
  type Http,
  type LoopbackSession,
  NotConfigured,
  refreshAccessToken,
  type ScopedSecrets,
  startLoopbackAuth,
} from "@rocky/connector-sdk";
import type { ConnectorHealth } from "@rocky/contracts";
import { z } from "zod";
import { CONNECTOR_SECRET_RE, type SecretName, type SecretStore } from "../secrets/keychain.ts";
import { egressHosts, guardFetch } from "./egress.ts";
import { ConnectorError } from "./errors.ts";
import type { ConnectorRegistry } from "./service.ts";

/**
 * The connector host (roadmap I1): everything that needs a connector's credentials or the
 * network runs behind this interface. The daemon talks to a forked host process (host-ipc.ts),
 * so the process that runs models never holds connector tokens. Tests use the in-process host.
 */

export interface SetupState {
  /** What still has to be done before the connector can sync, or null when it is set up. */
  missing: string | null;
  /** Which declared secrets are stored (never their values). */
  stored: Record<string, boolean>;
}

export interface HostSyncRequest {
  kind: string;
  config: unknown;
  cursor: unknown;
  since: number;
}

export interface HostSyncStream {
  batches: AsyncIterable<DocumentBatch<unknown>>;
  /** Requests made so far, including retries. */
  requests(): number;
  abort(): void;
}

export interface HostExecContext {
  idempotencyKey: string;
  config: unknown;
}

export interface ConnectorHost {
  /** Reloads cached setup state (the process host caches it; in-process is always live). */
  refresh(): Promise<void>;
  setup(kind: string): SetupState;
  setSecret(kind: string, name: string, value: string): Promise<void>;
  setOAuthClient(group: string, json: string): Promise<void>;
  /** Removes every secret under `prefix.` and forgets cached tokens. */
  deleteSecrets(prefix: string): Promise<void>;
  /** `done` resolves once the browser sign-in finished and the tokens are stored. */
  startOAuth(kind: string, scopes: string[]): Promise<{ authUrl: string; done: Promise<void> }>;
  health(kind: string, config: unknown): Promise<ConnectorHealth>;
  sync(req: HostSyncRequest, log: (msg: string) => void): HostSyncStream;
  execute(
    kind: string,
    type: string,
    payload: unknown,
    ctx: HostExecContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** Google's downloaded "Desktop app" client JSON. */
const ClientJsonSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
});

export interface InProcessHostDeps {
  registry: ConnectorRegistry;
  secrets: SecretStore;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
}

/** Runs connector code in the calling process. The forked host process wraps one of these. */
export class InProcessConnectorHost implements ConnectorHost {
  private readonly d: InProcessHostDeps;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly oauth = new Map<string, LoopbackSession>();
  /** Every host any connector was allowed for its config so far (the process-wide fetch guard). */
  readonly allowedHosts = new Set<string>();

  constructor(deps: InProcessHostDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

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
    const prefix = this.prefix(this.def(kind));
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

  /** A fetch limited to the hosts this connector declared for this config. */
  private fetchFor(def: Connector, config: unknown): typeof fetch {
    const hosts = egressHosts(def, config);
    for (const h of hosts) this.allowedHosts.add(h);
    return guardFetch(this.d.fetch ?? fetch, () => hosts, def.displayName);
  }

  private http(def: Connector, config: unknown): Http {
    return createHttp({
      fetch: this.fetchFor(def, config),
      log: (m) => this.d.log?.(`[${def.id}] ${m}`),
      concurrency: 4,
    });
  }

  private oauthClient(group: string): { client_id: string; client_secret: string } | null {
    const raw = this.d.secrets.get(`${group}.client` as SecretName);
    return raw ? (JSON.parse(raw) as { client_id: string; client_secret: string }) : null;
  }

  /** A fresh access token for an OAuth connector; cached until a minute before expiry. */
  private accessToken(def: Connector, config: unknown): (() => Promise<string>) | undefined {
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
        fetch: this.fetchFor(def, config),
      });
      this.tokens.set(spec.group, { token: t.accessToken, expiresAt: t.expiresAt });
      return t.accessToken;
    };
  }

  private missing(def: Connector): string | null {
    if (def.oauth) {
      if (!this.oauthClient(def.oauth.group))
        return "Import the Google client file to set up sign-in.";
      if (!this.d.secrets.has(`${def.oauth.group}.refresh` as SecretName))
        return "Sign in with Google.";
      return null;
    }
    const s = this.scopedSecrets(def.id);
    const absent = def.secrets.find((x) => !s.get(x.name));
    return absent ? `Add the ${absent.label}.` : null;
  }

  async refresh(): Promise<void> {}

  setup(kind: string): SetupState {
    const def = this.def(kind);
    const s = this.scopedSecrets(kind);
    return {
      missing: this.missing(def),
      stored: Object.fromEntries(def.secrets.map((x) => [x.name, s.get(x.name) !== null])),
    };
  }

  async setSecret(kind: string, name: string, value: string): Promise<void> {
    this.scopedSecrets(kind).set(name, value);
  }

  async setOAuthClient(group: string, json: string): Promise<void> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(json);
    } catch {
      // reported below
    }
    const parsed = ClientJsonSchema.safeParse(raw);
    if (!parsed.success)
      throw new ConnectorError(
        "BAD_REQUEST",
        'Not a Google "Desktop app" client file: expected {"installed": {"client_id", "client_secret"}}.',
      );
    this.d.secrets.set(`${group}.client` as SecretName, JSON.stringify(parsed.data.installed));
  }

  async deleteSecrets(prefix: string): Promise<void> {
    for (const name of this.d.secrets.list())
      if (name.startsWith(`${prefix}.`)) this.d.secrets.delete(name as SecretName);
    this.tokens.delete(prefix);
  }

  async startOAuth(kind: string, scopes: string[]) {
    const def = this.def(kind);
    const spec = def.oauth;
    if (!spec)
      throw new ConnectorError("BAD_REQUEST", `${def.displayName} doesn't use browser sign-in`);
    const client = this.oauthClient(spec.group);
    if (!client) throw new ConnectorError("BAD_REQUEST", "Import the Google client file first.");
    this.oauth.get(spec.group)?.close();
    const session = await startLoopbackAuth({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      scopes,
      authUrl: spec.authUrl,
      tokenUrl: spec.tokenUrl,
      fetch: this.fetchFor(def, {}),
    });
    this.oauth.set(spec.group, session);
    const done = session.done
      .then((t) => {
        // Google returns a refresh token on consent; keep the old one if this grant had none.
        if (t.refresh_token)
          this.d.secrets.set(`${spec.group}.refresh` as SecretName, t.refresh_token);
        this.tokens.set(spec.group, {
          token: t.access_token,
          expiresAt: this.now() + t.expires_in * 1000,
        });
      })
      .finally(() => this.oauth.delete(spec.group));
    return { authUrl: session.authUrl, done };
  }

  async health(kind: string, config: unknown): Promise<ConnectorHealth> {
    const def = this.def(kind);
    const token = this.accessToken(def, config);
    return def.health({
      config,
      http: this.http(def, config),
      secrets: this.scopedSecrets(kind),
      ...(token ? { accessToken: token } : {}),
    });
  }

  sync(req: HostSyncRequest, log: (msg: string) => void): HostSyncStream {
    const def = this.def(req.kind);
    const http = this.http(def, req.config);
    const controller = new AbortController();
    const self = this;
    async function* batches(): AsyncGenerator<DocumentBatch<unknown>> {
      const missing = self.missing(def);
      if (missing) throw new NotConfigured(missing);
      const token = self.accessToken(def, req.config);
      yield* def.sync(
        {
          config: req.config,
          http,
          secrets: self.scopedSecrets(def.id),
          log,
          signal: controller.signal,
          since: req.since,
          ...(token ? { accessToken: token } : {}),
        },
        req.cursor ?? undefined,
      );
    }
    return {
      batches: batches(),
      requests: () => http.requests,
      abort: () => controller.abort(),
    };
  }

  async execute(
    kind: string,
    type: string,
    payload: unknown,
    ctx: HostExecContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    const def = this.def(kind);
    const action = def.actions?.().find((a) => a.type === type);
    if (!action) throw new ConnectorError("NOT_FOUND", `${def.displayName} has no action ${type}`);
    // The host re-validates: the payload crossed a process boundary.
    const p = action.schema.parse(payload);
    const token = this.accessToken(def, ctx.config);
    return action.execute(p, {
      idempotencyKey: ctx.idempotencyKey,
      config: ctx.config,
      signal,
      http: this.http(def, ctx.config),
      secrets: this.scopedSecrets(kind),
      ...(token ? { accessToken: token } : {}),
    });
  }

  async close(): Promise<void> {
    for (const s of this.oauth.values()) s.close();
    this.oauth.clear();
  }
}

/** For processes that never run connectors (most CLI commands): every operation explains why. */
export class UnavailableConnectorHost implements ConnectorHost {
  private fail(): never {
    throw new ConnectorError(
      "BAD_REQUEST",
      "Connectors run in the connector host, which this command does not start.",
    );
  }
  async refresh(): Promise<void> {}
  setup(): SetupState {
    return {
      missing: "Connectors run in the connector host, which this command does not start.",
      stored: {},
    };
  }
  setSecret(): Promise<void> {
    this.fail();
  }
  setOAuthClient(): Promise<void> {
    this.fail();
  }
  deleteSecrets(): Promise<void> {
    this.fail();
  }
  startOAuth(): Promise<{ authUrl: string; done: Promise<void> }> {
    this.fail();
  }
  health(): Promise<ConnectorHealth> {
    this.fail();
  }
  sync(): HostSyncStream {
    this.fail();
  }
  execute(): Promise<unknown> {
    this.fail();
  }
  async close(): Promise<void> {}
}

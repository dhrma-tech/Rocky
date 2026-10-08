import { type ChildProcess, fork } from "node:child_process";
import {
  AuthExpired,
  type DocumentBatch,
  HttpError,
  NotConfigured,
  type SourceDocument,
} from "@rocky/connector-sdk";
import type { ConnectorHealth } from "@rocky/contracts";
import { ConnectorEgressBlocked } from "./egress.ts";
import { ConnectorError } from "./errors.ts";
import type {
  ConnectorHost,
  HostExecContext,
  HostSyncRequest,
  HostSyncStream,
  InProcessConnectorHost,
  SetupState,
} from "./host.ts";

/**
 * The wire between the daemon and the connector host process (roadmap I1). Requests carry ids;
 * a sync streams one batch at a time and waits for the daemon's ack, so a slow store applies
 * backpressure. Binary bodies are fetched in the host and cross as bytes. Secrets and tokens
 * never cross: the daemon can set a secret but never read one back.
 */

export interface Channel {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

interface WireError {
  message: string;
  code?: string;
  status?: number;
  body?: string;
}

type Op = "setSecret" | "setOAuthClient" | "deleteSecrets" | "health" | "execute" | "setupAll";

type ToHost =
  | { t: "call"; id: number; op: Op; args: unknown[] }
  | { t: "oauth"; id: number; kind: string; scopes: string[] }
  | { t: "sync"; id: number; req: HostSyncRequest }
  | { t: "ack"; id: number }
  | { t: "abort"; id: number };

type WireBody =
  | { kind: "text"; text?: string; units?: unknown[] }
  | { kind: "binary"; filename: string; bytes?: Uint8Array; error?: string };

type WireBatch = Omit<DocumentBatch<unknown>, "documents"> & {
  documents: (Omit<SourceDocument, "body"> & { body: WireBody })[];
};

type FromHost =
  | { t: "res"; id: number; value?: unknown; error?: WireError }
  | { t: "oauthDone"; id: number; error?: WireError }
  | { t: "batch"; id: number; batch: WireBatch; requests: number }
  | { t: "syncEnd"; id: number; requests: number; error?: WireError }
  | { t: "log"; msg: string };

export function toWireError(err: unknown): WireError {
  const e = err as { message?: unknown; code?: unknown; status?: unknown; body?: unknown };
  return {
    message: typeof e?.message === "string" ? e.message : String(err),
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    ...(typeof e?.status === "number" ? { status: e.status } : {}),
    ...(typeof e?.body === "string" ? { body: e.body } : {}),
  };
}

/** Rebuilds the error classes callers branch on (auth expired, HTTP status, bad request). */
export function fromWireError(w: WireError): Error {
  switch (w.code) {
    case "AUTH_EXPIRED":
      return new AuthExpired(w.message);
    case "NOT_CONFIGURED":
      return new NotConfigured(w.message);
    case "CONNECTOR_EGRESS_BLOCKED":
      return new ConnectorEgressBlocked(w.message);
    case "NOT_FOUND":
    case "BAD_REQUEST":
    case "ILLEGAL_TRANSITION":
      return new ConnectorError(w.code, w.message);
    case "HTTP_ERROR": {
      const e = new HttpError(w.status ?? 0, "http://connector-host/", w.body ?? "");
      e.message = w.message;
      return e;
    }
    default:
      return new Error(w.message);
  }
}

async function toWireBatch(b: DocumentBatch<unknown>): Promise<WireBatch> {
  const documents = await Promise.all(
    b.documents.map(async (d) => {
      if (d.body.kind === "text") return d as Omit<SourceDocument, "body"> & { body: WireBody };
      const { body, ...rest } = d;
      try {
        return {
          ...rest,
          body: { kind: "binary", filename: body.filename, bytes: await body.fetch() },
        };
      } catch (err) {
        return { ...rest, body: { kind: "binary", filename: body.filename, error: String(err) } };
      }
    }),
  );
  return { ...b, documents } as WireBatch;
}

function fromWireBatch(b: WireBatch): DocumentBatch<unknown> {
  return {
    ...b,
    documents: b.documents.map((d): SourceDocument => {
      if (d.body.kind === "text") return d as SourceDocument;
      const { bytes, error, filename } = d.body;
      return {
        ...d,
        body: {
          kind: "binary",
          filename,
          fetch: async () => {
            if (!bytes) throw new Error(error ?? "The connector host sent no bytes");
            return bytes;
          },
        },
      };
    }),
  };
}

/** Host side: serves one daemon over `ch` with a host that holds the keychain. */
export function serveConnectorHost(
  ch: Channel,
  host: InProcessConnectorHost,
  kinds: () => string[],
): void {
  const acks = new Map<number, () => void>();
  const aborts = new Map<number, () => void>();
  const reply = (m: FromHost) => ch.send(m);

  const call = async (op: Op, args: unknown[]): Promise<unknown> => {
    switch (op) {
      case "setSecret":
        return host.setSecret(args[0] as string, args[1] as string, args[2] as string);
      case "setOAuthClient":
        return host.setOAuthClient(args[0] as string, args[1] as string);
      case "deleteSecrets":
        return host.deleteSecrets(args[0] as string);
      case "health":
        return host.health(args[0] as string, args[1]);
      case "setupAll":
        return Object.fromEntries(
          kinds().map((k) => {
            try {
              return [k, host.setup(k)];
            } catch (err) {
              return [k, { missing: toWireError(err).message, stored: {} }];
            }
          }),
        );
      case "execute":
        throw new Error("execute is routed separately");
    }
  };

  ch.onMessage((raw) => {
    const m = raw as ToHost;
    if (m.t === "ack") return acks.get(m.id)?.();
    if (m.t === "abort") return aborts.get(m.id)?.();
    if (m.t === "call" && m.op === "execute") {
      const controller = new AbortController();
      aborts.set(m.id, () => controller.abort());
      const [kind, type, payload, ctx] = m.args as [string, string, unknown, HostExecContext];
      host
        .execute(kind, type, payload, ctx, controller.signal)
        .then(
          (value) => reply({ t: "res", id: m.id, value }),
          (err) => reply({ t: "res", id: m.id, error: toWireError(err) }),
        )
        .finally(() => aborts.delete(m.id));
      return;
    }
    if (m.t === "call") {
      call(m.op, m.args).then(
        (value) => reply({ t: "res", id: m.id, value }),
        (err) => reply({ t: "res", id: m.id, error: toWireError(err) }),
      );
      return;
    }
    if (m.t === "oauth") {
      host.startOAuth(m.kind, m.scopes).then(
        ({ authUrl, done }) => {
          reply({ t: "res", id: m.id, value: { authUrl } });
          done.then(
            () => reply({ t: "oauthDone", id: m.id }),
            (err) => reply({ t: "oauthDone", id: m.id, error: toWireError(err) }),
          );
        },
        (err) => reply({ t: "res", id: m.id, error: toWireError(err) }),
      );
      return;
    }
    if (m.t === "sync") {
      const stream = host.sync(m.req, (msg) => reply({ t: "log", msg }));
      aborts.set(m.id, () => stream.abort());
      void (async () => {
        try {
          for await (const b of stream.batches) {
            const acked = new Promise<void>((resolve) => acks.set(m.id, resolve));
            reply({
              t: "batch",
              id: m.id,
              batch: await toWireBatch(b),
              requests: stream.requests(),
            });
            await acked;
          }
          reply({ t: "syncEnd", id: m.id, requests: stream.requests() });
        } catch (err) {
          reply({ t: "syncEnd", id: m.id, requests: stream.requests(), error: toWireError(err) });
        } finally {
          acks.delete(m.id);
          aborts.delete(m.id);
        }
      })();
    }
  });
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface SyncState {
  queue: FromHost[];
  wake?: () => void;
  requests: number;
}

/** Daemon side. `connect` starts (or restarts) the host; a crashed host is restarted on the next call. */
export class ConnectorHostClient implements ConnectorHost {
  private ch: (Channel & { close(): void }) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly oauthDone = new Map<number, Pending>();
  private readonly syncs = new Map<number, SyncState>();
  private cache: Record<string, SetupState> = {};
  private readonly connect: (onExit: () => void) => Channel & { close(): void };
  private readonly log: (msg: string) => void;

  constructor(opts: {
    connect: (onExit: () => void) => Channel & { close(): void };
    log?: (msg: string) => void;
  }) {
    this.connect = opts.connect;
    this.log = opts.log ?? (() => {});
  }

  private channel(): Channel {
    if (this.ch) return this.ch;
    const ch = this.connect(() => this.onExit());
    ch.onMessage((m) => this.onMessage(m as FromHost));
    this.ch = ch;
    return ch;
  }

  private onExit() {
    this.ch = null;
    const err = new Error("The connector host stopped. It restarts on the next request.");
    for (const p of [...this.pending.values(), ...this.oauthDone.values()]) p.reject(err);
    this.pending.clear();
    this.oauthDone.clear();
    for (const [id, s] of this.syncs) {
      s.queue.push({ t: "syncEnd", id, requests: s.requests, error: { message: err.message } });
      s.wake?.();
    }
  }

  private onMessage(m: FromHost) {
    if (m.t === "log") return this.log(m.msg);
    if (m.t === "res") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(fromWireError(m.error));
      else p?.resolve(m.value);
      return;
    }
    if (m.t === "oauthDone") {
      const p = this.oauthDone.get(m.id);
      this.oauthDone.delete(m.id);
      if (m.error) p?.reject(fromWireError(m.error));
      else p?.resolve(undefined);
      return;
    }
    const s = this.syncs.get(m.id);
    if (!s) return;
    s.queue.push(m);
    s.wake?.();
  }

  private request<T>(msg: Omit<ToHost & { t: "call" | "oauth" }, "id">): Promise<T> {
    const ch = this.channel();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ch.send({ ...msg, id });
    });
  }

  private call<T>(op: Op, ...args: unknown[]): Promise<T> {
    return this.request<T>({ t: "call", op, args } as Omit<ToHost & { t: "call" }, "id">);
  }

  /** Loads every connector's setup state; called at start and after any change. */
  async refresh(): Promise<void> {
    this.cache = await this.call<Record<string, SetupState>>("setupAll");
  }

  setup(kind: string): SetupState {
    return (
      this.cache[kind] ?? {
        missing: "The connector host hasn't reported this connector yet.",
        stored: {},
      }
    );
  }

  async setSecret(kind: string, name: string, value: string): Promise<void> {
    await this.call("setSecret", kind, name, value);
    await this.refresh();
  }

  async setOAuthClient(group: string, json: string): Promise<void> {
    await this.call("setOAuthClient", group, json);
    await this.refresh();
  }

  async deleteSecrets(prefix: string): Promise<void> {
    await this.call("deleteSecrets", prefix);
    await this.refresh();
  }

  async startOAuth(kind: string, scopes: string[]) {
    const ch = this.channel();
    const id = this.nextId++;
    const done = new Promise<void>((resolve, reject) =>
      this.oauthDone.set(id, { resolve: () => resolve(), reject }),
    ).then(() => this.refresh());
    // Avoid an unhandled rejection when the caller only wants the URL.
    done.catch(() => {});
    const res = await new Promise<{ authUrl: string }>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ch.send({ t: "oauth", id, kind, scopes } satisfies ToHost);
    });
    return { authUrl: res.authUrl, done };
  }

  health(kind: string, config: unknown): Promise<ConnectorHealth> {
    return this.call("health", kind, config);
  }

  async execute(
    kind: string,
    type: string,
    payload: unknown,
    ctx: HostExecContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    const ch = this.channel();
    const id = this.nextId++;
    const onAbort = () => ch.send({ t: "abort", id } satisfies ToHost);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        ch.send({
          t: "call",
          id,
          op: "execute",
          args: [kind, type, payload, ctx],
        } satisfies ToHost);
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  sync(req: HostSyncRequest): HostSyncStream {
    const ch = this.channel();
    const id = this.nextId++;
    const state: SyncState = { queue: [], requests: 0 };
    this.syncs.set(id, state);
    ch.send({ t: "sync", id, req } satisfies ToHost);
    const self = this;
    async function* batches(): AsyncGenerator<DocumentBatch<unknown>> {
      try {
        for (;;) {
          const m = state.queue.shift();
          if (!m) {
            await new Promise<void>((resolve) => {
              state.wake = resolve;
            });
            state.wake = undefined;
            continue;
          }
          if (m.t === "batch") {
            state.requests = m.requests;
            yield fromWireBatch(m.batch);
            self.ch?.send({ t: "ack", id } satisfies ToHost);
          } else if (m.t === "syncEnd") {
            state.requests = m.requests;
            if (m.error) throw fromWireError(m.error);
            return;
          }
        }
      } finally {
        self.syncs.delete(id);
      }
    }
    return {
      batches: batches(),
      requests: () => state.requests,
      abort: () => this.ch?.send({ t: "abort", id } satisfies ToHost),
    };
  }

  async close(): Promise<void> {
    this.ch?.close();
    this.ch = null;
  }
}

/** Forks `entry` (a .ts file run by Node's type stripping) as the connector host process. */
export function forkConnectorHost(
  entry: string,
  args: string[],
  log?: (msg: string) => void,
): ConnectorHostClient {
  return new ConnectorHostClient({
    ...(log ? { log } : {}),
    connect: (onExit) => {
      const child: ChildProcess = fork(entry, args, {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let closing = false;
      child.on("exit", (code) => {
        if (!closing) log?.(`connector host exited (code ${code})`);
        onExit();
      });
      return {
        send: (m) => child.send(m as never),
        onMessage: (cb) => child.on("message", cb),
        close: () => {
          closing = true;
          child.kill();
        },
      };
    },
  });
}

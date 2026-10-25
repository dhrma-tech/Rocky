import { type ChildProcess, fork } from "node:child_process";
import type { ChannelHost, ChannelName, ChannelSecret, ChannelStatus } from "./host.ts";
import { ChannelBlocked } from "./host.ts";
import type { PhoneMessage } from "./ntfy.ts";
import type { TelegramInbound, TelegramOutbound } from "./telegram.ts";

/**
 * The wire between the daemon and the channel host process (D-065), the same shape as the
 * connector host's: numbered requests, one answer each. Secrets cross only one way, into the
 * host; nothing the host answers contains one.
 */

export interface Wire {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

type Op =
  | "sendNtfy"
  | "sendTelegram"
  | "answerCallback"
  | "telegramIdentity"
  | "setSecret"
  | "deleteSecrets"
  | "status";
type ToHost = { t: "call"; id: number; op: Op; args: unknown[] };
type FromHost =
  | { t: "res"; id: number; value?: unknown; error?: { message: string; code?: string } }
  | { t: "log"; msg: string }
  /** A Telegram message from an allowed user, for the daemon to answer (D-066). */
  | { t: "inbound"; inbound: TelegramInbound };

/** Host side: hands the daemon one Telegram message from an allowed user. */
export function emitInbound(wire: Wire, inbound: TelegramInbound): void {
  wire.send({ t: "inbound", inbound } satisfies FromHost);
}

/** Host side: answers calls with the in-process host. */
export function serveChannelHost(wire: Wire, host: ChannelHost): void {
  wire.onMessage(async (raw) => {
    const m = raw as ToHost;
    if (m?.t !== "call") return;
    try {
      const fn = host[m.op] as (...a: unknown[]) => Promise<unknown>;
      const value = await fn.apply(host, m.args);
      wire.send({ t: "res", id: m.id, value } satisfies FromHost);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      wire.send({
        t: "res",
        id: m.id,
        error: {
          message: e?.message ?? String(err),
          ...(typeof e?.code === "string" ? { code: e.code } : {}),
        },
      } satisfies FromHost);
    }
  });
}

interface Conn extends Wire {
  close(): void;
}

/** Daemon side. Starts the host on first use; a crashed host restarts on the next call. */
export class ChannelHostClient implements ChannelHost {
  private conn: Conn | null = null;
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly connect: (onExit: () => void) => Conn;
  private readonly log: ((msg: string) => void) | undefined;
  private inbound: ((m: TelegramInbound) => void) | null = null;

  constructor(opts: { connect: (onExit: () => void) => Conn; log?: (msg: string) => void }) {
    this.connect = opts.connect;
    this.log = opts.log;
  }

  private wire(): Conn {
    if (this.conn) return this.conn;
    const conn = this.connect(() => {
      this.conn = null;
      for (const p of this.pending.values())
        p.reject(new Error("The channel host stopped. It restarts on the next request."));
      this.pending.clear();
    });
    conn.onMessage((raw) => {
      const m = raw as FromHost;
      if (m?.t === "log") return this.log?.(`channel host: ${m.msg}`);
      if (m?.t === "inbound") return this.inbound?.(m.inbound);
      if (m?.t !== "res") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) {
        const e =
          m.error.code === "EGRESS_BLOCKED"
            ? new ChannelBlocked(m.error.message)
            : Object.assign(new Error(m.error.message), m.error.code ? { code: m.error.code } : {});
        p.reject(e);
      } else p.resolve(m.value);
    });
    this.conn = conn;
    return conn;
  }

  private call<T>(op: Op, ...args: unknown[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.wire().send({ t: "call", id, op, args } satisfies ToHost);
    });
  }

  /** Telegram messages from allowed users arrive here while the host runs. */
  onInbound(cb: (m: TelegramInbound) => void): void {
    this.inbound = cb;
  }

  sendNtfy(m: PhoneMessage): Promise<void> {
    return this.call("sendNtfy", m);
  }
  sendTelegram(m: TelegramOutbound): Promise<void> {
    return this.call("sendTelegram", m);
  }
  answerCallback(callbackId: string, text: string): Promise<void> {
    return this.call("answerCallback", callbackId, text);
  }
  telegramIdentity(): Promise<string> {
    return this.call("telegramIdentity");
  }
  setSecret(name: ChannelSecret, value: string): Promise<void> {
    return this.call("setSecret", name, value);
  }
  deleteSecrets(channel: ChannelName): Promise<void> {
    return this.call("deleteSecrets", channel);
  }
  status(): Promise<ChannelStatus> {
    return this.call("status");
  }
  async close(): Promise<void> {
    this.conn?.close();
    this.conn = null;
  }
}

/** Forks `entry` (a .ts file run by Node's type stripping) as the channel host process. */
export function forkChannelHost(
  entry: string,
  args: string[],
  log?: (msg: string) => void,
): ChannelHostClient {
  return new ChannelHostClient({
    ...(log ? { log } : {}),
    connect: (onExit) => {
      const child: ChildProcess = fork(entry, args, {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let closing = false;
      child.on("exit", (code) => {
        if (!closing) log?.(`channel host exited (code ${code})`);
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

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

export const SESSION_COOKIE = "rocky_session";
/** A paired phone's long-lived cookie (docs/PHONE.md). Sent only over HTTPS. */
export const DEVICE_COOKIE = "rocky_device";
const CODE_TTL_MS = 60_000;
const PAIR_TTL_MS = 5 * 60_000;
/** Wrong guesses before a pairing code stops working (a 6-digit code must not be brute-forced). */
const PAIR_ATTEMPTS = 5;

const random = () => randomBytes(32).toString("hex");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface DeviceVerifier {
  /** True when the device cookie belongs to a paired, unrevoked, unexpired device. */
  verify(token: string): boolean;
}

/**
 * Daemon exposure rules (SECURITY.md):
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defense), or a name the
 *   user allowed for their phone (`daemon.allowedHosts`), and then only when the proxy in front
 *   says the request came over HTTPS (`tailscale serve` sets X-Forwarded-Proto). The daemon
 *   itself listens on 127.0.0.1 only.
 * - A foreign Origin is always rejected; cookie-authenticated state changes need a matching
 *   Origin (CSRF defense).
 * - Every /api route needs the install token (Bearer, CLI/MCP) or a session cookie (UI), except
 *   /api/v1/health. Requests by an allowed name need a paired device's cookie, and nothing else.
 * - The UI gets its session through a one-time bootstrap code (`rocky open`); a phone pairs with
 *   a 6-digit code shown on this computer.
 */
export class Auth {
  private readonly token: string;
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;
  private readonly sessions = new Set<string>();
  private readonly codes = new Map<string, number>();
  private readonly now: () => number;
  private readonly allowedHosts: () => string[];
  private readonly devices: DeviceVerifier | undefined;
  private pair: { code: string; expires: number; misses: number } | null = null;

  constructor(opts: {
    token: string;
    port: number;
    now?: () => number;
    /** Read on every request, so a change in Settings applies at once. */
    allowedHosts?: () => string[];
    devices?: DeviceVerifier;
  }) {
    this.token = opts.token;
    this.hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
    this.origins = new Set([...this.hosts].map((h) => `http://${h}`));
    this.now = opts.now ?? Date.now;
    this.allowedHosts = opts.allowedHosts ?? (() => []);
    this.devices = opts.devices;
  }

  /** One-time code for GET /auth/bootstrap; expires after 60 s. */
  issueCode(): string {
    const code = random();
    this.codes.set(code, this.now() + CODE_TTL_MS);
    return code;
  }

  /** Consumes a bootstrap code and returns a new session secret, or null. */
  redeemCode(code: string): string | null {
    const exp = this.codes.get(code);
    this.codes.delete(code);
    if (!exp || exp < this.now()) return null;
    const session = random();
    this.sessions.add(session);
    return session;
  }

  /** A 6-digit pairing code for a phone, valid 5 minutes. A new code replaces the last one. */
  issuePairCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = this.now() + PAIR_TTL_MS;
    this.pair = { code, expires, misses: 0 };
    return { code, expiresAt: expires };
  }

  /** True once for the right code; five wrong guesses or the time running out end it. */
  redeemPairCode(code: string): boolean {
    const p = this.pair;
    if (!p || p.expires < this.now()) {
      this.pair = null;
      return false;
    }
    if (safeEqual(code, p.code)) {
      this.pair = null;
      return true;
    }
    p.misses++;
    if (p.misses >= PAIR_ATTEMPTS) this.pair = null;
    return false;
  }

  private bearerOk(header: string | undefined): boolean {
    const m = /^Bearer (.+)$/.exec(header ?? "");
    return Boolean(m?.[1] && safeEqual(m[1], this.token));
  }

  private sessionOk(value: string | undefined): boolean {
    return Boolean(value && [...this.sessions].some((s) => safeEqual(s, value)));
  }

  private hostOf(c: Context): string {
    return (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
  }

  /** Reached by an allowed name (a phone through the proxy), not as 127.0.0.1 or localhost. */
  isRemote(c: Context): boolean {
    return !this.hosts.has(this.hostOf(c));
  }

  /** Host and Origin checks for every request, including static files and bootstrap. */
  hostGuard(): MiddlewareHandler {
    return async (c, next) => {
      const host = this.hostOf(c);
      const origin = c.req.header("origin");
      if (this.hosts.has(host)) {
        if (origin && !this.origins.has(origin)) return c.json({ error: "forbidden origin" }, 403);
        return next();
      }
      const allowed = this.allowedHosts().includes(host);
      if (!allowed || c.req.header("x-forwarded-proto") !== "https")
        return c.json({ error: "forbidden host" }, 403);
      if (origin && origin !== `https://${host}`) return c.json({ error: "forbidden origin" }, 403);
      await next();
    };
  }

  /** Token or session for /api routes; a paired device's cookie when reached by an allowed name. */
  apiGuard(): MiddlewareHandler {
    return async (c, next) => {
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (this.isRemote(c)) {
        const device = getCookie(c, DEVICE_COOKIE);
        if (!device || !this.devices?.verify(device))
          return c.json({ error: "this device isn't paired", code: "NOT_PAIRED" }, 401);
        if (unsafe && !c.req.header("origin")) return c.json({ error: "origin required" }, 403);
        return next();
      }
      if (this.bearerOk(c.req.header("authorization"))) return next();
      if (this.sessionOk(getCookie(c, SESSION_COOKIE))) {
        // hostGuard already rejected foreign origins; a cookie write must also carry ours.
        if (unsafe && !c.req.header("origin")) return c.json({ error: "origin required" }, 403);
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    };
  }

  /** For routes a phone may not use: secrets, deleting data, pairing more devices. */
  localOnly(): MiddlewareHandler {
    return async (c, next) => {
      if (this.isRemote(c))
        return c.json({ error: "only on the computer Rocky runs on", code: "LOCAL_ONLY" }, 403);
      await next();
    };
  }

  /** Only the bearer token may mint bootstrap codes (the CLI, not a browser session). */
  isBearer(header: string | undefined): boolean {
    return this.bearerOk(header);
  }
}

export const newToken = random;

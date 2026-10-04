import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

export const SESSION_COOKIE = "rocky_session";
const CODE_TTL_MS = 60_000;

const random = () => randomBytes(32).toString("hex");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Daemon exposure rules (SECURITY.md):
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS-rebinding defense).
 * - A foreign Origin is always rejected; cookie-authenticated state changes need a matching
 *   Origin (CSRF defense).
 * - Every /api route needs the install token (Bearer, CLI/MCP) or a session cookie (UI), except
 *   /api/v1/health.
 * - The UI gets its session through a one-time bootstrap code (`rocky open`).
 */
export class Auth {
  private readonly token: string;
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;
  private readonly sessions = new Set<string>();
  private readonly codes = new Map<string, number>();
  private readonly now: () => number;

  constructor(opts: { token: string; port: number; now?: () => number }) {
    this.token = opts.token;
    this.hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
    this.origins = new Set([...this.hosts].map((h) => `http://${h}`));
    this.now = opts.now ?? Date.now;
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

  private bearerOk(header: string | undefined): boolean {
    const m = /^Bearer (.+)$/.exec(header ?? "");
    return Boolean(m?.[1] && safeEqual(m[1], this.token));
  }

  private sessionOk(value: string | undefined): boolean {
    return Boolean(value && [...this.sessions].some((s) => safeEqual(s, value)));
  }

  /** Host and Origin checks for every request, including static files and bootstrap. */
  hostGuard(): MiddlewareHandler {
    return async (c, next) => {
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      if (!this.hosts.has(host)) return c.json({ error: "forbidden host" }, 403);
      const origin = c.req.header("origin");
      if (origin && !this.origins.has(origin)) return c.json({ error: "forbidden origin" }, 403);
      await next();
    };
  }

  /** Token or session for /api routes. */
  apiGuard(): MiddlewareHandler {
    return async (c, next) => {
      if (this.bearerOk(c.req.header("authorization"))) return next();
      if (this.sessionOk(getCookie(c, SESSION_COOKIE))) {
        const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
        // hostGuard already rejected foreign origins; a cookie write must also carry ours.
        if (unsafe && !c.req.header("origin")) return c.json({ error: "origin required" }, 403);
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    };
  }

  /** Only the bearer token may mint bootstrap codes (the CLI, not a browser session). */
  isBearer(header: string | undefined): boolean {
    return this.bearerOk(header);
  }
}

export const newToken = random;

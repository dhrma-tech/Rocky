import { AuthExpired, type Http, HttpError, type OAuthSpec } from "@rocky/connector-sdk";
import { parse } from "node-html-parser";

/**
 * Google shared sign-in (CONNECTORS.md #1–3): one Desktop OAuth client in the user's own GCP
 * project, loopback + PKCE, one refresh token for Gmail, Calendar and Drive. Read scopes only in
 * Phase 4; write scopes are requested in Phase 6 together with the draft/event executors.
 */
export const GOOGLE_GROUP = "google-oauth";

export const googleOAuth = (scopes: string[]): OAuthSpec => ({
  group: GOOGLE_GROUP,
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes,
});

export interface GoogleCtx {
  http: Http;
  accessToken?: () => Promise<string>;
}

export class NotFound extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/** GET (or POST) with a fresh bearer token. 404/410 become NotFound so callers can resync. */
export async function gfetch(ctx: GoogleCtx, url: string): Promise<Response> {
  if (!ctx.accessToken) throw new AuthExpired("Sign in with Google on the Connectors page.");
  const res = await ctx.http.fetch(url, {
    headers: { authorization: `Bearer ${await ctx.accessToken()}` },
  });
  if (res.ok) return res;
  const body = await res.text();
  if (res.status === 401)
    throw new AuthExpired("Google rejected the sign-in. Reconnect Google on the Connectors page.");
  if (res.status === 404 || res.status === 410) throw new NotFound(res.status, body.slice(0, 200));
  if (res.status === 403 && /insufficient|scope/i.test(body))
    throw new AuthExpired(
      "Google sign-in is missing a permission for this connector. Reconnect Google.",
    );
  throw new HttpError(res.status, url, body);
}

export async function gjson<T>(ctx: GoogleCtx, url: string): Promise<T> {
  return (await (await gfetch(ctx, url)).json()) as T;
}

/** Visible text of an HTML fragment (email bodies, event descriptions). */
export function htmlToText(html: string): string {
  const root = parse(html, { blockTextElements: { script: false, style: false, pre: true } });
  return root.structuredText.replace(/\n{3,}/g, "\n\n").trim();
}

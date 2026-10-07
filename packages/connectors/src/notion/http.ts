import { AuthExpired, type Http, HttpError } from "@rocky/connector-sdk";

/** Notion REST plumbing shared by the sync (index.ts) and the write actions (actions.ts). */

export const API = "https://api.notion.com/v1";
export const VERSION = "2026-03-11";

export const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "notion-version": VERSION,
  "content-type": "application/json",
});

export function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add the Notion integration token on the Connectors page.");
  return t;
}

/** GET without a body, POST with one, or an explicit method (PATCH for updates). */
export async function call<T>(
  http: Http,
  tok: string,
  url: string,
  body?: unknown,
  opts: { method?: "GET" | "POST" | "PATCH"; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await http.fetch(url, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers: headers(tok),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text();
  if (res.status === 401)
    throw new AuthExpired("Notion rejected the token. Paste a new integration token.");
  if (!res.ok) throw new HttpError(res.status, url, text);
  return JSON.parse(text) as T;
}

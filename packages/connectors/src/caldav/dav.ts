import { AuthExpired, type Http, HttpError } from "@rocky/connector-sdk";
import { type HTMLElement, parse } from "node-html-parser";

/**
 * CalDAV over plain requests (RFC 4791, RFC 6578 sync-collection), sent through the SDK's http
 * wrapper so retries, rate limits and fixture replay apply. XML is read by local tag name, so
 * any namespace prefix (d:, D:, none) works.
 */

export const ICLOUD = "https://caldav.icloud.com/";

export interface DavAuth {
  http: Http;
  /** "Basic …" */
  authorization: string;
}

export const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;

const localName = (el: HTMLElement) => (el.rawTagName ?? "").split(":").pop()?.toLowerCase() ?? "";

/** Every descendant element with this local name, in document order. */
export function all(el: HTMLElement, name: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (n: HTMLElement) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      const e = c as HTMLElement;
      if (localName(e) === name) out.push(e);
      walk(e);
    }
  };
  walk(el);
  return out;
}
export const first = (el: HTMLElement, name: string) => all(el, name)[0];
/** Decoded text content (calendar-data arrives entity-escaped). */
export const text = (el: HTMLElement | undefined) => (el ? el.text.trim() : "");

export function xml(body: string): HTMLElement {
  return parse(body, { lowerCaseTagName: false, comment: false, blockTextElements: {} });
}

/** A WebDAV request; 401 means the app-specific password was rejected. */
export async function dav(
  a: DavAuth,
  method: "PROPFIND" | "REPORT" | "PUT",
  url: string,
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ status: number; root: HTMLElement; text: string }> {
  const res = await a.http.fetch(url, {
    method,
    headers: {
      authorization: a.authorization,
      "content-type":
        method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8",
      ...headers,
    },
    body,
    ...(signal ? { signal } : {}),
  });
  const t = await res.text();
  if (res.status === 401)
    throw new AuthExpired(
      "iCloud rejected the Apple ID or app-specific password. Create a new app-specific password.",
    );
  return { status: res.status, root: xml(t), text: t };
}

/** Absolute URL for an href returned relative to the request URL. */
export const abs = (href: string, base: string) => new URL(href, base).toString();

const PROPFIND = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`;

async function propfind(a: DavAuth, url: string, depth: "0" | "1", props: string) {
  const r = await dav(a, "PROPFIND", url, PROPFIND(props), { depth });
  if (r.status !== 207) throw new HttpError(r.status, url, r.text);
  return r.root;
}

export interface DavCalendar {
  url: string;
  name: string;
  syncToken: string | null;
}

/** current-user-principal → calendar-home-set → calendars that hold events. */
export async function discover(a: DavAuth, start = ICLOUD): Promise<DavCalendar[]> {
  const p = await propfind(a, start, "0", "<d:current-user-principal/>");
  const principal = abs(text(first(first(p, "current-user-principal") ?? p, "href")), start);
  const h = await propfind(a, principal, "0", "<c:calendar-home-set/>");
  const home = abs(text(first(first(h, "calendar-home-set") ?? h, "href")), principal);
  const list = await propfind(
    a,
    home,
    "1",
    "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:sync-token/>",
  );
  const out: DavCalendar[] = [];
  for (const r of all(list, "response")) {
    const type = first(r, "resourcetype");
    if (!type || !first(type, "calendar")) continue;
    const comps = all(r, "comp").map((c) => (c.getAttribute("name") ?? "").toUpperCase());
    if (comps.length && !comps.includes("VEVENT")) continue;
    out.push({
      url: abs(text(first(r, "href")), home),
      name: text(first(r, "displayname")) || "Calendar",
      syncToken: text(first(r, "sync-token")) || null,
    });
  }
  return out;
}

export interface SyncChanges {
  changed: string[];
  deleted: string[];
  token: string;
}

/**
 * RFC 6578 sync-collection. An empty token lists every resource. Returns null when the server
 * says the token is no longer valid (the caller restarts with an empty token).
 */
export async function syncCollection(
  a: DavAuth,
  calendarUrl: string,
  token: string,
): Promise<SyncChanges | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
  const r = await dav(a, "REPORT", calendarUrl, body, { depth: "1" });
  if ((r.status === 403 || r.status === 409) && /valid-sync-token/i.test(r.text)) return null;
  if (r.status !== 207) throw new HttpError(r.status, calendarUrl, r.text);
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const res of all(r.root, "response")) {
    const href = abs(text(first(res, "href")), calendarUrl);
    if (href.replace(/\/$/, "") === calendarUrl.replace(/\/$/, "")) continue;
    // A deleted member has a response-level 404 status and no propstat.
    const direct = res.childNodes.find(
      (c) => c.nodeType === 1 && localName(c as HTMLElement) === "status",
    ) as HTMLElement | undefined;
    if (direct && / 404 /.test(text(direct))) deleted.push(href);
    else if (/\.ics$/i.test(href)) changed.push(href);
  }
  return { changed, deleted, token: text(first(r.root, "sync-token")) };
}

/** calendar-multiget: href → iCalendar text, in batches of 50. */
export async function multiget(
  a: DavAuth,
  calendarUrl: string,
  hrefs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < hrefs.length; i += 50) {
    const batch = hrefs.slice(i, i + 50);
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${batch
      .map((h) => `<d:href>${new URL(h).pathname}</d:href>`)
      .join("")}</c:calendar-multiget>`;
    const r = await dav(a, "REPORT", calendarUrl, body, { depth: "1" });
    if (r.status !== 207) throw new HttpError(r.status, calendarUrl, r.text);
    for (const res of all(r.root, "response")) {
      const data = text(first(res, "calendar-data"));
      if (data) out.set(abs(text(first(res, "href")), calendarUrl), data);
    }
  }
  return out;
}

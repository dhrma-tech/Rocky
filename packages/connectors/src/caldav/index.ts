import { createHash } from "node:crypto";
import {
  AuthExpired,
  type Connector,
  type ConnectorAction,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";
import {
  basic,
  type DavAuth,
  type DavCalendar,
  dav,
  discover,
  multiget,
  syncCollection,
} from "./dav.ts";
import { buildEvent, type IcsEvent, parseEvent } from "./ics.ts";

/**
 * Apple Calendar over CalDAV (CONNECTORS.md #9): iCloud with an app-specific password (Apple ID
 * with two-factor authentication). Discovery from caldav.icloud.com; incremental with RFC 6578
 * sync-collection per calendar; event bodies via calendar-multiget. Written by hand rather than
 * with tsdav so requests go through the SDK http wrapper and fixture replay (Phase 7 decision).
 */

const DAY = 86_400_000;

export const CaldavConfigSchema = z.object({
  appleId: z.email(),
  /** Calendar names to sync; empty = every event calendar. */
  calendars: z.array(z.string().min(1).max(200)).max(50).default([]),
  backfillDays: z.number().int().min(1).max(3650).default(90),
  /** The CalDAV start URL (iCloud by default; other CalDAV servers work too). */
  serverUrl: z.url().default("https://caldav.icloud.com/"),
});
export type CaldavConfig = z.infer<typeof CaldavConfigSchema>;
/** Per calendar URL: its sync token. */
export type CaldavCursor = Record<string, string>;

function auth(
  ctx: { http: DavAuth["http"]; secrets: { get(n: string): string | null } },
  appleId: string,
): DavAuth {
  const pw = ctx.secrets.get("app_password");
  if (!pw) throw new AuthExpired("Add an Apple app-specific password on the Connectors page.");
  return { http: ctx.http, authorization: basic(appleId, pw) };
}

export function eventToDocument(href: string, cal: DavCalendar, e: IcsEvent): SourceDocument {
  const when = e.allDay ? `${e.start} (all day)` : `${e.start}${e.end ? ` – ${e.end}` : ""}`;
  const text = [
    `When: ${when}`,
    e.location ? `Where: ${e.location}` : "",
    e.organizer ? `Organizer: ${e.organizer}` : "",
    e.attendees.length ? `Attendees: ${e.attendees.join(", ")}` : "",
    e.rrule ? `Repeats: ${e.rrule}` : "",
    e.description ? `\n${e.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const start = e.allDay ? Date.parse(`${e.start}T00:00:00`) : Date.parse(e.start);
  return {
    externalId: href,
    sourceType: "calendar",
    title: e.summary || "(no title)",
    createdAt: start,
    updatedAt: start,
    mime: "text/calendar",
    body: { kind: "text", units: [{ anchor: { kind: "event", eventId: e.uid }, text }] },
    meta: {
      calendar: cal.name,
      start: e.start,
      ...(e.end ? { end: e.end } : {}),
      allDay: e.allDay,
      attendeeEmails: e.attendees,
      uid: e.uid,
      ...(e.rrule ? { recurrence: e.rrule } : {}),
      ...(e.status ? { status: e.status } : {}),
    },
  };
}

const When = z
  .object({ dateTime: z.iso.datetime({ offset: true }).optional(), date: z.iso.date().optional() })
  .strict()
  .refine((w) => Boolean(w.dateTime) !== Boolean(w.date), "set exactly one of dateTime or date");

/** No attendees: iCloud sends invitations itself for events with attendees, so V1 leaves them out. */
const EventCreateSchema = z
  .object({
    /** Calendar name; empty = the first event calendar. */
    calendar: z.string().max(200).optional(),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((s) => !/[\r\n]/.test(s), "one line"),
    description: z.string().max(8000).optional(),
    location: z.string().max(500).optional(),
    start: When,
    end: When,
  })
  .strict();
type EventCreate = z.infer<typeof EventCreateSchema>;

/** The UID for an idempotency key: a retry PUTs the same resource and gets 412. */
export const uidFor = (key: string) =>
  `rocky-${createHash("sha256").update(key).digest("hex").slice(0, 32)}@rocky.local`;

const eventCreate: ConnectorAction<EventCreate> = {
  type: "caldav.eventCreate",
  title: "Create Apple Calendar event",
  schema: EventCreateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Apple Calendar${p.calendar ? ` / ${p.calendar}` : ""}`,
    summary: `New event "${p.summary}" ${p.start.dateTime ?? p.start.date}`,
    diff: p,
  }),
  async execute(p, ctx) {
    const cfg = CaldavConfigSchema.parse(ctx.config);
    const a = auth(ctx, cfg.appleId);
    const cals = await discover(a, cfg.serverUrl);
    const cal = p.calendar
      ? cals.find((c) => c.name.toLowerCase() === p.calendar?.toLowerCase())
      : cals[0];
    if (!cal)
      throw new Error(p.calendar ? `No calendar named "${p.calendar}"` : "No event calendar found");
    const uid = uidFor(ctx.idempotencyKey);
    const url = new URL(
      `${encodeURIComponent(uid)}.ics`,
      cal.url.endsWith("/") ? cal.url : `${cal.url}/`,
    ).toString();
    const r = await dav(
      a,
      "PUT",
      url,
      buildEvent({
        uid,
        summary: p.summary,
        description: p.description,
        location: p.location,
        start: p.start,
        end: p.end,
        now: Date.now(),
      }),
      { "if-none-match": "*" },
      ctx.signal,
    );
    if (r.status === 412) return { uid, url, reused: true };
    if (r.status !== 201 && r.status !== 204) throw new HttpError(r.status, url, r.text);
    return { uid, url };
  },
};

/**
 * CalDAV servers hand out calendar homes on sibling hosts (iCloud: caldav.icloud.com sends
 * p42-caldav.icloud.com), so the parent domain of the server is allowed too when it has one.
 */
export function serverHosts(serverUrl: string): string[] {
  const labels = new URL(serverUrl).hostname.split(".");
  return labels.length >= 3 ? [serverUrl, `*.${labels.slice(1).join(".")}`] : [serverUrl];
}

export const caldav: Connector<CaldavConfig, CaldavCursor> = {
  id: "caldav",
  tier: "experimental",
  egress: (c) => serverHosts(c.serverUrl),
  displayName: "Apple Calendar",
  permissions: "Reads iCloud calendar events; creates events (without guests) after approval",
  configSchema: CaldavConfigSchema,
  secrets: [
    {
      name: "app_password",
      label: "app-specific password",
      description:
        "account.apple.com → Sign-In and Security → App-Specific Passwords → Generate (needs two-factor authentication). Your normal Apple ID password does not work.",
    },
  ],
  defaultIntervalMin: 15,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const a = auth(ctx, ctx.config.appleId);
    const wanted = ctx.config.calendars.map((c) => c.toLowerCase());
    const cals = (await discover(a, ctx.config.serverUrl)).filter(
      (c) => !wanted.length || wanted.includes(c.name.toLowerCase()),
    );
    const next: CaldavCursor = { ...(cursor ?? {}) };
    const floor = Math.max(ctx.since, Date.now() - ctx.config.backfillDays * DAY);
    for (const cal of cals) {
      const token = next[cal.url] ?? "";
      let changes = await syncCollection(a, cal.url, token);
      const full = changes === null || token === "";
      if (changes === null) {
        // The token expired: list everything again.
        changes = await syncCollection(a, cal.url, "");
      }
      if (!changes) continue;
      const bodies = await multiget(a, cal.url, changes.changed);
      const documents: SourceDocument[] = [];
      const deleted = [...changes.deleted];
      for (const [href, ics] of bodies) {
        const e = parseEvent(ics);
        if (!e) continue;
        if (e.status === "CANCELLED") {
          deleted.push(href);
          continue;
        }
        const end = Date.parse(
          e.end && !e.allDay ? e.end : e.allDay ? `${e.start}T00:00:00` : e.start,
        );
        // The first sync keeps the backfill window; recurring events always count (they repeat).
        if (full && !e.rrule && end < floor) continue;
        documents.push(eventToDocument(href, cal, e));
      }
      next[cal.url] = changes.token;
      yield {
        documents,
        // No presence list: it would span every calendar of this connector. After an expired
        // token, events deleted in the gap stay until edited (rare; documented).
        ...(deleted.length ? { deletedExternalIds: deleted } : {}),
        cursor: { ...next },
      };
    }
    yield { documents: [], cursor: next };
  },
  async health(ctx) {
    const cals = await discover(auth(ctx, ctx.config.appleId), ctx.config.serverUrl);
    return {
      status: cals.length ? "ok" : "degraded",
      message: cals.length
        ? `Signed in as ${ctx.config.appleId}: ${cals.map((c) => c.name).join(", ")}`
        : "Signed in, but no event calendars were found.",
      account: ctx.config.appleId,
    };
  },
  actions: () => [eventCreate],
};

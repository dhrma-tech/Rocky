import type { Connector, SourceDocument } from "@rocky/connector-sdk";
import { z } from "zod";
import { type GoogleCtx, gjson, googleOAuth, htmlToText, NotFound } from "./common.ts";

/**
 * Google Calendar read-sync (CONNECTORS.md #2). Verified 2026-10-06: events.list with
 * singleEvents=true; the first sync passes timeMin, later ones only the syncToken (timeMin can't
 * be combined with it); nextSyncToken is on the last page; incremental results include cancelled
 * events; 410 GONE → clear and full sync.
 */

const API = "https://www.googleapis.com/calendar/v3";

export const GcalConfigSchema = z.object({
  calendars: z.array(z.string().min(1)).min(1).max(20).default(["primary"]),
  backfillDays: z.number().int().min(1).max(3650).default(90),
});
export type GcalConfig = z.infer<typeof GcalConfigSchema>;
/** Per calendar id: the sync token. */
export type GcalCursor = Record<string, string>;

interface GEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}
interface EventsPage {
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const when = (t?: { dateTime?: string; date?: string }) => t?.dateTime ?? t?.date ?? "";

export const eventId = (calendar: string, id: string) => `${calendar}:${id}`;

export function eventToDocument(calendar: string, e: GEvent): SourceDocument {
  const people = (e.attendees ?? []).map(
    (a) => `${a.displayName ?? a.email ?? "?"}${a.responseStatus ? ` (${a.responseStatus})` : ""}`,
  );
  const desc = e.description
    ? /<[a-z][\s\S]*>/i.test(e.description)
      ? htmlToText(e.description)
      : e.description
    : "";
  const text = [
    `When: ${when(e.start)} – ${when(e.end)}`,
    e.location ? `Where: ${e.location}` : "",
    e.organizer ? `Organizer: ${e.organizer.displayName ?? e.organizer.email}` : "",
    people.length ? `Attendees: ${people.join(", ")}` : "",
    desc ? `\n${desc}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const start = Date.parse(when(e.start));
  return {
    externalId: eventId(calendar, e.id),
    sourceType: "calendar",
    title: e.summary || "(no title)",
    ...(e.htmlLink ? { uri: e.htmlLink } : {}),
    ...(e.organizer?.email
      ? {
          author: {
            email: e.organizer.email,
            ...(e.organizer.displayName ? { name: e.organizer.displayName } : {}),
          },
        }
      : {}),
    createdAt: e.created ? Date.parse(e.created) : start,
    updatedAt: e.updated ? Date.parse(e.updated) : start,
    mime: "text/calendar",
    body: { kind: "text", units: [{ anchor: { kind: "event", eventId: e.id }, text }] },
    meta: {
      calendar,
      start: when(e.start),
      end: when(e.end),
      status: e.status,
      attendees: (e.attendees ?? []).length,
    },
  };
}

async function* listCalendar(
  ctx: GoogleCtx,
  calendar: string,
  params: string,
): AsyncGenerator<{ docs: SourceDocument[]; gone: string[]; syncToken?: string }> {
  let pageToken: string | undefined;
  do {
    const page: EventsPage = await gjson(
      ctx,
      `${API}/calendars/${encodeURIComponent(calendar)}/events?singleEvents=true&maxResults=250&${params}${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    const docs: SourceDocument[] = [];
    const gone: string[] = [];
    for (const e of page.items ?? []) {
      if (e.status === "cancelled") gone.push(eventId(calendar, e.id));
      else docs.push(eventToDocument(calendar, e));
    }
    pageToken = page.nextPageToken;
    yield { docs, gone, ...(page.nextSyncToken ? { syncToken: page.nextSyncToken } : {}) };
  } while (pageToken);
}

export const gcal: Connector<GcalConfig, GcalCursor> = {
  id: "gcal",
  displayName: "Google Calendar",
  permissions: "Reads events",
  configSchema: GcalConfigSchema,
  secrets: [],
  oauth: googleOAuth(["https://www.googleapis.com/auth/calendar.readonly"]),
  defaultIntervalMin: 10,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const next: GcalCursor = { ...cursor };
    let resynced = false;
    const listedInFull = new Set<string>();
    const present: string[] = [];
    for (const cal of ctx.config.calendars) {
      const token = next[cal];
      const full = `timeMin=${encodeURIComponent(new Date(ctx.since).toISOString())}`;
      try {
        for await (const page of listCalendar(
          ctx,
          cal,
          token ? `syncToken=${encodeURIComponent(token)}` : full,
        )) {
          if (page.syncToken) next[cal] = page.syncToken;
          if (!token) {
            listedInFull.add(cal);
            present.push(...page.docs.map((d) => d.externalId));
          }
          yield { documents: page.docs, deletedExternalIds: page.gone, cursor: { ...next } };
        }
      } catch (err) {
        if (!(err instanceof NotFound) || !token || err.status !== 410) throw err;
        // Sync token expired: list the calendar again from scratch.
        ctx.log(`Calendar ${cal}: sync token expired (410); running a full sync.`);
        delete next[cal];
        resynced = true;
        listedInFull.add(cal);
        for await (const page of listCalendar(ctx, cal, full)) {
          if (page.syncToken) next[cal] = page.syncToken;
          present.push(...page.docs.map((d) => d.externalId));
          yield {
            documents: page.docs,
            deletedExternalIds: page.gone,
            cursor: { ...next },
            fullResync: true,
          };
        }
      }
    }
    // After a 410 resync, events that weren't listed again are gone; that's only knowable when
    // every calendar was listed in full during this run.
    if (resynced && listedInFull.size === ctx.config.calendars.length)
      yield { documents: [], presentExternalIds: present, cursor: { ...next } };
  },
  async health(ctx) {
    const cal = await gjson<{ id: string; summary?: string }>(ctx, `${API}/calendars/primary`);
    return { status: "ok", message: `Reading ${cal.summary ?? cal.id}`, account: cal.id };
  },
};

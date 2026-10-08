import { createHash } from "node:crypto";
import type { ConnectorAction, ExecContext } from "@rocky/connector-sdk";
import { HttpError } from "@rocky/connector-sdk";
import { z } from "zod";
import { gjson, gsend } from "./common.ts";

/**
 * Calendar writes (actions.md). Verified 2026-10-07:
 * - events.insert: POST /calendar/v3/calendars/{calendarId}/events?sendUpdates=all|externalOnly|none
 *   The client may set `id` (base32hex: a-v and 0-9, 5–1024 chars), which makes create idempotent;
 *   a repeated id is rejected with 409, and then the existing event is returned.
 * - events.patch: PATCH …/events/{eventId}?sendUpdates=…
 * - Scope calendar.events. Guests are only notified when the payload says so; risk is high
 *   whenever attendees are involved (invites leave the user's account).
 */

const API = "https://www.googleapis.com/calendar/v3";

const When = z
  .object({
    /** RFC 3339 date-time, or a yyyy-mm-dd date for all-day events. */
    dateTime: z.iso.datetime({ offset: true }).optional(),
    date: z.iso.date().optional(),
    timeZone: z.string().max(64).optional(),
  })
  .strict()
  .refine((w) => Boolean(w.dateTime) !== Boolean(w.date), "set exactly one of dateTime or date");

const oneLine = (s: string) => !/[\r\n]/.test(s);
const Fields = {
  calendarId: z.string().min(1).max(200).default("primary"),
  summary: z.string().trim().min(1).max(300).refine(oneLine, "one line"),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  start: When,
  end: When,
  attendees: z.array(z.email()).max(50).default([]),
  /** Send invitations/updates to guests. Off by default. */
  notifyAttendees: z.boolean().default(false),
};

export const EventCreateSchema = z.object(Fields).strict();
export type EventCreate = z.infer<typeof EventCreateSchema>;

export const EventPatchSchema = z
  .object({
    calendarId: Fields.calendarId,
    eventId: z.string().min(1).max(1024),
    summary: Fields.summary.optional(),
    description: Fields.description,
    location: Fields.location,
    start: When.optional(),
    end: When.optional(),
    attendees: z.array(z.email()).max(50).optional(),
    notifyAttendees: Fields.notifyAttendees,
  })
  .strict();
export type EventPatch = z.infer<typeof EventPatchSchema>;

/** The event id for an idempotency key: hex is a subset of base32hex. */
export const eventIdFor = (key: string) =>
  `rk${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

interface GEvent {
  id: string;
  htmlLink?: string;
}

const calendars = (config: unknown) =>
  ((config as { calendars?: string[] } | null)?.calendars ?? ["primary"]).map(String);

function checkCalendar(ctx: ExecContext, id: string) {
  if (!calendars(ctx.config).includes(id))
    throw new Error(`${id} is not one of the calendars configured for Google Calendar`);
}

const sendUpdates = (notify: boolean) => (notify ? "all" : "none");
const eventsUrl = (cal: string) => `${API}/calendars/${encodeURIComponent(cal)}/events`;

const body = (p: Partial<EventCreate>) => ({
  ...(p.summary !== undefined ? { summary: p.summary } : {}),
  ...(p.description !== undefined ? { description: p.description } : {}),
  ...(p.location !== undefined ? { location: p.location } : {}),
  ...(p.start ? { start: p.start } : {}),
  ...(p.end ? { end: p.end } : {}),
  ...(p.attendees ? { attendees: p.attendees.map((email) => ({ email })) } : {}),
});

const whenText = (w?: { dateTime?: string | undefined; date?: string | undefined }) =>
  w?.dateTime ?? w?.date ?? "";

export const eventCreate: ConnectorAction<EventCreate> = {
  type: "gcal.eventCreate",
  title: "Create calendar event",
  schema: EventCreateSchema,
  risk: (p) => (p.attendees.length ? "high" : "medium"),
  // Guests get the event (and, if notified, an email): that reaches other people.
  actionClass: (p) => (p.attendees.length || p.notifyAttendees ? "send" : "write"),
  describe: (p) => ({
    target: p.calendarId,
    summary: `New event "${p.summary}" ${whenText(p.start)}${p.attendees.length ? ` with ${p.attendees.length} guest${p.attendees.length === 1 ? "" : "s"}${p.notifyAttendees ? " (invitations are sent)" : " (no invitations sent)"}` : ""}`,
    diff: { ...body(p), notifyAttendees: p.notifyAttendees },
  }),
  async execute(p, ctx) {
    checkCalendar(ctx, p.calendarId);
    const id = eventIdFor(ctx.idempotencyKey);
    try {
      const e = await gsend<GEvent>(
        ctx,
        "POST",
        `${eventsUrl(p.calendarId)}?sendUpdates=${sendUpdates(p.notifyAttendees)}`,
        { id, ...body(p) },
        ctx.signal,
      );
      return { eventId: e.id, url: e.htmlLink ?? null };
    } catch (err) {
      // Same id already exists: a retry after a timeout. Return the event that was created.
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
      const e = await gjson<GEvent>(ctx, `${eventsUrl(p.calendarId)}/${id}`);
      return { eventId: e.id, url: e.htmlLink ?? null, reused: true };
    }
  },
};

export const eventPatch: ConnectorAction<EventPatch> = {
  type: "gcal.eventPatch",
  title: "Update calendar event",
  schema: EventPatchSchema,
  risk: (p) => (p.attendees?.length || p.notifyAttendees ? "high" : "medium"),
  actionClass: (p) => (p.attendees?.length || p.notifyAttendees ? "send" : "write"),
  describe: (p) => ({
    target: p.calendarId,
    summary: `Update event ${p.summary ? `"${p.summary}"` : p.eventId}${p.notifyAttendees ? " (guests are notified)" : ""}`,
    diff: body(p as Partial<EventCreate>),
  }),
  async execute(p, ctx) {
    checkCalendar(ctx, p.calendarId);
    // PATCH sets the same fields again on a retry, so it is idempotent as is.
    const e = await gsend<GEvent>(
      ctx,
      "PATCH",
      `${eventsUrl(p.calendarId)}/${encodeURIComponent(p.eventId)}?sendUpdates=${sendUpdates(p.notifyAttendees)}`,
      body(p as Partial<EventCreate>),
      ctx.signal,
    );
    return { eventId: e.id, url: e.htmlLink ?? null };
  },
};

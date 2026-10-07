import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { all, xml } from "../src/caldav/dav.ts";
import { buildEvent, parseEvent, unfold } from "../src/caldav/ics.ts";
import { caldav, uidFor } from "../src/caldav/index.ts";

// Hand-built from RFC 4791 / RFC 6578 and iCloud's discovery flow (2026-10-07); fixture-only
// until an iCloud account is connected (Phase 7 live check).

const ROOT = "https://caldav.icloud.com/";
const HOME = "https://p42-caldav.icloud.com/123/calendars/";
const CAL = `${HOME}home/`;
const config = { appleId: "me@icloud.com", calendars: [], backfillDays: 90, serverUrl: ROOT };
const secrets = () => memorySecrets({ app_password: "abcd-efgh-ijkl-mnop" });

const ms = (body: string) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;

const discovery = [
  {
    method: "PROPFIND",
    url: ROOT,
    status: 207,
    body: ms(
      "<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>",
    ),
  },
  {
    method: "PROPFIND",
    url: "https://caldav.icloud.com/123/principal/",
    status: 207,
    body: ms(
      `<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>${HOME}</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>`,
    ),
  },
  {
    method: "PROPFIND",
    url: HOME,
    status: 207,
    // Unprefixed default namespace on purpose: servers differ.
    body: `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response><response><href>/123/calendars/home/</href><propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Home</displayname><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/></supported-calendar-component-set><sync-token>T0</sync-token></prop></propstat></response><response><href>/123/calendars/tasks/</href><propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Reminders</displayname><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VTODO"/></supported-calendar-component-set></prop></propstat></response></multistatus>`,
  },
];

const ICS_A = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Kolkata",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:a-1",
  "DTSTART;TZID=Asia/Kolkata:20261020T093000",
  "DTEND;TZID=Asia/Kolkata:20261020T103000",
  "SUMMARY:Thesis check-in\\, room 2",
  "DESCRIPTION:Bring the draft.\\nChapter 2 first.",
  'ATTENDEE;CN="Rao, Prof":mailto:Prof@Uni.edu',
  "BEGIN:VALARM",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");
const ICS_B =
  "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b-1\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nSUMMARY:Hack\r\n athon\r\nEND:VEVENT\r\nEND:VCALENDAR";

describe("iCalendar", () => {
  it("parses zoned, all-day and folded events and ignores alarm fields", () => {
    expect(parseEvent(ICS_A)).toMatchObject({
      uid: "a-1",
      summary: "Thesis check-in, room 2",
      description: "Bring the draft.\nChapter 2 first.",
      start: "2026-10-20T04:00:00.000Z",
      end: "2026-10-20T05:00:00.000Z",
      allDay: false,
      attendees: ["prof@uni.edu"],
    });
    expect(parseEvent(ICS_B)).toMatchObject({
      summary: "Hackathon",
      start: "2026-10-24",
      end: "2026-10-25",
      allDay: true,
    });
    expect(parseEvent("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeNull();
  });

  it("round-trips an event Rocky writes, escaping text and folding long lines", () => {
    const ics = buildEvent({
      uid: "u1",
      summary: "Review; plan, go",
      description: "x".repeat(200),
      start: { dateTime: "2026-10-20T09:00:00+05:30" },
      end: { dateTime: "2026-10-20T10:00:00+05:30" },
      now: Date.UTC(2026, 9, 7),
    });
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(unfold(ics)).toContain("DTSTART:20261020T033000Z");
    expect(parseEvent(ics)).toMatchObject({
      summary: "Review; plan, go",
      description: "x".repeat(200),
      start: "2026-10-20T03:30:00.000Z",
    });
  });

  it("reads XML by local name whatever the prefix", () => {
    const root = xml(
      "<D:multistatus xmlns:D='DAV:'><D:response><D:href>/a</D:href></D:response><response><href>/b</href></response></D:multistatus>",
    );
    expect(all(root, "href").map((h) => h.text)).toEqual(["/a", "/b"]);
  });
});

describe("Apple Calendar sync", () => {
  it("discovers event calendars, syncs everything once, then only changes; 404s are tombstones", async () => {
    const r = replay([
      ...discovery,
      {
        method: "REPORT",
        url: CAL,
        status: 207,
        body: ms(
          `<d:response><d:href>/123/calendars/home/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/123/calendars/home/b.ics</d:href><d:propstat><d:prop><d:getetag>"2"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:sync-token>T1</d:sync-token>`,
        ),
      },
      {
        method: "REPORT",
        url: CAL,
        status: 207,
        body: ms(
          `<d:response><d:href>/123/calendars/home/a.ics</d:href><d:propstat><d:prop><cal:calendar-data>${ICS_A.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop></d:propstat></d:response><d:response><d:href>/123/calendars/home/b.ics</d:href><d:propstat><d:prop><cal:calendar-data>${ICS_B}</cal:calendar-data></d:prop></d:propstat></d:response>`,
        ),
      },
    ]);
    const since = Date.UTC(2026, 9, 1);
    const res = await runSync(caldav, { fetch: r.fetch, config, secrets: secrets(), since });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => [d.externalId, d.title, d.sourceType])).toEqual([
      [`${CAL}a.ics`, "Thesis check-in, room 2", "calendar"],
      [`${CAL}b.ics`, "Hackathon", "calendar"],
    ]);
    expect(res.documents[0]?.meta).toMatchObject({
      calendar: "Home",
      start: "2026-10-20T04:00:00.000Z",
      attendeeEmails: ["prof@uni.edu"],
      allDay: false,
    });
    expect(res.cursor).toEqual({ [CAL]: "T1" });

    const s = replay([
      ...discovery,
      {
        method: "REPORT",
        url: CAL,
        status: 207,
        body: ms(
          `<d:response><d:href>/123/calendars/home/b.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:sync-token>T2</d:sync-token>`,
        ),
      },
    ]);
    const next = await runSync(caldav, {
      fetch: s.fetch,
      config,
      secrets: secrets(),
      cursor: { [CAL]: "T1" },
    });
    expect(next.deleted).toEqual([`${CAL}b.ics`]);
    expect(next.cursor).toEqual({ [CAL]: "T2" });
  });

  it("an expired sync token starts over with an empty one", async () => {
    let tokens: string[] = [];
    const base = replay([
      ...discovery,
      {
        method: "REPORT",
        url: CAL,
        status: 403,
        body: ms("<d:error><d:valid-sync-token/></d:error>"),
      },
      { method: "REPORT", url: CAL, status: 207, body: ms("<d:sync-token>T9</d:sync-token>") },
    ]);
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const m = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(String(init?.body ?? ""));
      if (m) tokens = [...tokens, m[1] ?? ""];
      return base.fetch(u, init);
    }) as typeof fetch;
    const res = await runSync(caldav, {
      fetch: f,
      config,
      secrets: secrets(),
      cursor: { [CAL]: "OLD" },
    });
    expect(tokens).toEqual(["OLD", ""]);
    expect(res.cursor).toEqual({ [CAL]: "T9" });
  });

  it("a rejected password asks for a new app-specific one", async () => {
    const r = replay([{ method: "PROPFIND", url: ROOT, status: 401, body: "" }]);
    await expect(
      runSync(caldav, { fetch: r.fetch, config, secrets: secrets() }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Apple Calendar events", () => {
  const [create] = caldav.actions?.() ?? [];
  if (!create) throw new Error("action missing");
  const uid = uidFor("01KEY");
  const url = `${CAL}${encodeURIComponent(uid)}.ics`;
  const ctx = (f: typeof fetch): ExecContext => ({
    idempotencyKey: "01KEY",
    signal: new AbortController().signal,
    config,
    http: createHttp({ fetch: f, sleep: async () => {}, random: () => 0 }),
    secrets: secrets(),
  });
  const p = () =>
    create.schema.parse({
      summary: "Office hours",
      start: { dateTime: "2026-10-20T10:00:00Z" },
      end: { dateTime: "2026-10-20T10:30:00Z" },
    });

  it("PUTs a new resource with If-None-Match; a retry's 412 means it already exists", async () => {
    let put: RequestInit | undefined;
    const r = replay([...discovery, { method: "PUT", url, status: 201, body: "" }]);
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") put = init;
      return r.fetch(u, init);
    }) as typeof fetch;
    expect(await create.execute(p(), ctx(f))).toEqual({ uid, url });
    expect(new Headers(put?.headers).get("if-none-match")).toBe("*");
    expect(String(put?.body)).toContain(`UID:${uid}`);
    expect(String(put?.body)).not.toContain("ATTENDEE");

    const again = replay([...discovery, { method: "PUT", url, status: 412, body: "" }]);
    expect(await create.execute(p(), ctx(again.fetch))).toEqual({ uid, url, reused: true });
    expect(create.schema.safeParse({ ...p(), attendees: ["x@y.z"] }).success).toBe(false);
  });
});

import { replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { gcal } from "../src/google/gcal.ts";
import { gdrive } from "../src/google/gdrive.ts";
import { gmail, messageText, stripQuoted } from "../src/google/gmail.ts";

// Hand-built from developers.google.com shapes (verified 2026-10-06); to be replaced by scrubbed
// recordings from a real account (acceptance #1).
const accessToken = async () => "ya29.test";
const since = Date.parse("2026-07-08T00:00:00Z");
const b64 = (s: string) => Buffer.from(s).toString("base64url");

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const message = (
  id: string,
  threadId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  threadId,
  internalDate: "1759500000000",
  historyId: "900",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Priya Shah" <priya@acme.io>' },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "Budget for Q4" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64(text) } },
      { mimeType: "text/html", body: { data: b64(`<p>${text}</p>`) } },
    ],
  },
  ...extra,
});
const gmailCfg = { backfillDays: 90, query: "-in:spam -in:trash" };
const listUrl = `${GM}/messages?maxResults=500&q=${encodeURIComponent("newer_than:90d -in:spam -in:trash")}`;

describe("Gmail", () => {
  it("backfills threads with one anchored unit per message and a thread deep link", async () => {
    const r = replay([
      { url: `${GM}/profile`, body: { emailAddress: "me@example.com", historyId: "1000" } },
      {
        url: listUrl,
        body: {
          messages: [
            { id: "m1", threadId: "t1" },
            { id: "m2", threadId: "t1" },
            { id: "m3", threadId: "t2" },
          ],
        },
      },
      {
        url: `${GM}/threads/t1?format=full`,
        body: {
          id: "t1",
          historyId: "990",
          messages: [
            message("m1", "t1", "Can you send the budget?"),
            message(
              "m2",
              "t1",
              "Sure, by Friday.\n\nOn Mon, Priya wrote:\n> Can you send the budget?",
            ),
          ],
        },
      },
      {
        url: `${GM}/threads/t2?format=full`,
        body: {
          id: "t2",
          historyId: "991",
          messages: [message("m3", "t2", "spam", { labelIds: ["SPAM"] })],
        },
      },
    ]);
    const res = await runSync(gmail, { fetch: r.fetch, config: gmailCfg, accessToken, since });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => d.externalId)).toEqual(["t1"]);
    expect(res.deleted).toEqual(["t2"]); // only spam left → not indexed
    const t1 = res.documents[0];
    expect(t1).toMatchObject({
      title: "Budget for Q4",
      uri: "https://mail.google.com/mail/u/0/#all/t1",
      author: { name: "Priya Shah", email: "priya@acme.io" },
    });
    if (t1?.body.kind !== "text") throw new Error("text body expected");
    expect(t1.body.units?.map((u) => [u.anchor, u.text])).toEqual([
      [{ kind: "message", messageId: "m1", threadId: "t1" }, "Can you send the budget?"],
      [{ kind: "message", messageId: "m2", threadId: "t1" }, "Sure, by Friday."],
    ]);
    expect(res.cursor).toEqual({ historyId: "1000" });
  });

  it("incremental sync reads history and refetches only the changed threads (acceptance #2)", async () => {
    const r = replay([
      {
        url: `${GM}/history?startHistoryId=1000&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=500`,
        body: {
          historyId: "1010",
          history: [
            { messagesAdded: [{ message: { id: "m4", threadId: "t1" } }] },
            { messagesDeleted: [{ message: { id: "m9", threadId: "t9" } }] },
          ],
        },
      },
      {
        url: `${GM}/threads/t1?format=full`,
        body: {
          id: "t1",
          historyId: "1009",
          messages: [message("m1", "t1", "Can you send the budget?"), message("m4", "t1", "Sent!")],
        },
      },
      { url: `${GM}/threads/t9?format=full`, status: 404, body: { error: { code: 404 } } },
    ]);
    const res = await runSync(gmail, {
      fetch: r.fetch,
      config: gmailCfg,
      accessToken,
      cursor: { historyId: "1000" },
    });
    expect(res.documents.map((d) => d.externalId)).toEqual(["t1"]);
    expect(res.deleted).toEqual(["t9"]);
    expect(res.requests).toBe(3);
    expect(res.cursor).toEqual({ historyId: "1010" });
  });

  it("falls back to a full resync when the history id has expired", async () => {
    const r = replay([
      {
        url: `${GM}/history?startHistoryId=5&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=500`,
        status: 404,
        body: {},
      },
      { url: `${GM}/profile`, body: { historyId: "2000" } },
      { url: listUrl, body: {} },
    ]);
    const res = await runSync(gmail, {
      fetch: r.fetch,
      config: gmailCfg,
      accessToken,
      cursor: { historyId: "5" },
    });
    expect(res.cursor).toEqual({ historyId: "2000" });
  });

  it("maps a revoked sign-in to auth expired", async () => {
    const r = replay([{ url: `${GM}/profile`, status: 401, body: {} }]);
    await expect(
      runSync(gmail, { fetch: r.fetch, config: gmailCfg, accessToken, since }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("extracts text from HTML-only mail and drops quoted history", () => {
    expect(
      messageText({
        mimeType: "text/html",
        body: { data: b64("<div>Hello <b>there</b></div><style>x{}</style>") },
      }),
    ).toBe("Hello there");
    expect(stripQuoted("Thanks!\n\nOn Tue, 6 Oct 2026, Ana wrote:\n> old text\n> more")).toBe(
      "Thanks!",
    );
  });
});

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "confirmed",
  summary: "Linear algebra midterm",
  location: "Hall B",
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  updated: "2026-10-01T10:00:00Z",
  start: { dateTime: "2026-11-03T09:00:00+05:30" },
  end: { dateTime: "2026-11-03T11:00:00+05:30" },
  attendees: [{ email: "me@example.com", responseStatus: "accepted" }],
  ...extra,
});
const calCfg = { calendars: ["primary"], backfillDays: 90 };
const fullUrl = (page?: string) =>
  `${CAL}?singleEvents=true&maxResults=250&timeMin=${encodeURIComponent(new Date(since).toISOString())}${page ? `&pageToken=${page}` : ""}`;
const incUrl = (tok: string) => `${CAL}?singleEvents=true&maxResults=250&syncToken=${tok}`;

describe("Google Calendar", () => {
  it("full sync pages through events and stores the sync token from the last page", async () => {
    const r = replay([
      { url: fullUrl(), body: { items: [event("e1")], nextPageToken: "p2" } },
      {
        url: fullUrl("p2"),
        body: { items: [event("e2", { summary: "Office hours" })], nextSyncToken: "S1" },
      },
    ]);
    const res = await runSync(gcal, { fetch: r.fetch, config: calCfg, accessToken, since });
    expect(res.documents.map((d) => d.externalId)).toEqual(["primary:e1", "primary:e2"]);
    expect(res.cursor).toEqual({ primary: "S1" });
    const e1 = res.documents[0];
    if (e1?.body.kind !== "text") throw new Error("text body expected");
    expect(e1.body.units?.[0]).toMatchObject({
      anchor: { kind: "event", eventId: "e1" },
      text: expect.stringMatching(/^When: 2026-11-03T09:00/),
    });
  });

  it("incremental sync uses only the sync token; cancelled events are tombstones", async () => {
    const r = replay([
      {
        url: incUrl("S1"),
        body: { items: [event("e1", { status: "cancelled" }), event("e3")], nextSyncToken: "S2" },
      },
    ]);
    const res = await runSync(gcal, {
      fetch: r.fetch,
      config: calCfg,
      accessToken,
      cursor: { primary: "S1" },
    });
    expect(res.documents.map((d) => d.externalId)).toEqual(["primary:e3"]);
    expect(res.deleted).toEqual(["primary:e1"]);
    expect(res.cursor).toEqual({ primary: "S2" });
  });

  it("410 GONE → full resync with a presence list so stale events are removed", async () => {
    const r = replay([
      { url: incUrl("OLD"), status: 410, body: { error: { code: 410 } } },
      { url: fullUrl(), body: { items: [event("e3")], nextSyncToken: "S9" } },
    ]);
    const res = await runSync(gcal, {
      fetch: r.fetch,
      config: calCfg,
      accessToken,
      cursor: { primary: "OLD" },
      since,
    });
    expect(res.fullResync).toBe(true);
    expect(res.batches.at(-1)).toMatchObject({
      presentExternalIds: ["primary:e3"],
      cursor: { primary: "S9" },
    });
  });
});

const DR = "https://www.googleapis.com/drive/v3";
const FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,webViewLink,size,trashed,parents,owners(displayName,emailAddress)";
const file = (id: string, mimeType: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `File ${id}`,
  mimeType,
  createdTime: "2026-09-01T00:00:00Z",
  modifiedTime: "2026-09-10T00:00:00Z",
  webViewLink: `https://docs.google.com/d/${id}`,
  ...extra,
});
const DOC = "application/vnd.google-apps.document";
const driveCfg = { backfillDays: 90, maxFileMb: 10 };

describe("Google Drive", () => {
  it("backfills Docs as Markdown exports and skips unsupported types, then stores the change token", async () => {
    const q = `trashed=false and modifiedTime > '${new Date(since).toISOString()}' and (mimeType='${DOC}' or mimeType='application/vnd.google-apps.presentation' or mimeType='application/pdf')`;
    const r = replay([
      { url: `${DR}/changes/startPageToken`, body: { startPageToken: "T100" } },
      {
        url: `${DR}/files?pageSize=100&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}`,
        body: { files: [file("d1", DOC), file("x1", "image/png")] },
      },
      {
        url: `${DR}/files/d1/export?mimeType=text%2Fmarkdown`,
        headers: { "content-type": "text/markdown" },
        body: "# Syllabus\n\nExam on Nov 3.",
      },
    ]);
    const res = await runSync(gdrive, { fetch: r.fetch, config: driveCfg, accessToken, since });
    expect(res.documents.map((d) => [d.externalId, d.sourceType])).toEqual([["d1", "markdown"]]);
    expect(res.cursor).toEqual({ pageToken: "T100" });
    const d1 = res.documents[0];
    if (d1?.body.kind !== "binary") throw new Error("lazy export expected");
    expect(new TextDecoder().decode(await d1.body.fetch())).toBe("# Syllabus\n\nExam on Nov 3.");
  });

  it("change feed: removed and trashed files are tombstones; the new start token is stored", async () => {
    const r = replay([
      {
        url: `${DR}/changes?pageToken=T100&pageSize=100&includeRemoved=true&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`)}`,
        body: {
          newStartPageToken: "T101",
          changes: [
            { fileId: "d1", removed: true },
            { fileId: "d2", file: file("d2", DOC, { trashed: true }) },
            { fileId: "p1", file: file("p1", "application/pdf", { size: "1000" }) },
          ],
        },
      },
    ]);
    const res = await runSync(gdrive, {
      fetch: r.fetch,
      config: driveCfg,
      accessToken,
      cursor: { pageToken: "T100" },
    });
    expect(res.deleted).toEqual(["d1", "d2"]);
    expect(res.documents.map((d) => [d.externalId, d.sourceType, d.body.kind])).toEqual([
      ["p1", "pdf", "binary"],
    ]);
    expect(res.cursor).toEqual({ pageToken: "T101" });
    expect(res.requests).toBe(1);
  });
});

describe("Drive folder ancestors (notebook rules)", () => {
  it("records every folder above a file, looking each folder up once", async () => {
    const r = replay([
      {
        url: `${DR}/changes?pageToken=T1&pageSize=100&includeRemoved=true&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`)}`,
        body: {
          newStartPageToken: "T2",
          changes: [
            { fileId: "a", file: file("a", "application/pdf", { size: "10", parents: ["week1"] }) },
            { fileId: "b", file: file("b", "application/pdf", { size: "10", parents: ["week1"] }) },
          ],
        },
      },
      { url: `${DR}/files/week1?fields=parents`, body: { parents: ["cs201"] } },
      { url: `${DR}/files/cs201?fields=parents`, body: { parents: ["root"] } },
      { url: `${DR}/files/root?fields=parents`, body: {} },
    ]);
    const res = await runSync(gdrive, {
      fetch: r.fetch,
      config: driveCfg,
      accessToken,
      cursor: { pageToken: "T1" },
    });
    expect(res.documents.map((d) => d.meta?.ancestors)).toEqual([
      ["week1", "cs201", "root"],
      ["week1", "cs201", "root"],
    ]);
    expect(r.unused()).toEqual([]);
    expect(res.requests).toBe(4);
  });
});

import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { eventCreate, eventIdFor, eventPatch } from "../src/google/gcal-events.ts";
import { sourcePackWrite } from "../src/google/gdrive-pack.ts";
import { draftCreate, draftUpdate, rfc2822 } from "../src/google/gmail-drafts.ts";
import { pageCreate, rowCreate, toBlocks, toProperties } from "../src/notion/actions.ts";

// Request shapes hand-built from the API references (verified 2026-10-07); to be checked against
// a real account (Phase 6 live acceptance).

type Sent = { method: string; url: string; body: string; headers: Record<string, string> };

/** Replay plus a log of every request body (to check what would be written). */
function exchange(list: Parameters<typeof replay>[0]) {
  const r = replay(list);
  const sent: Sent[] = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      url: String(u),
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return r.fetch(u, init);
  }) as typeof fetch;
  return { ...r, fetch: fetchFn, sent };
}

const ctx = (fetchFn: typeof fetch, extra: Partial<ExecContext> = {}): ExecContext => ({
  idempotencyKey: "01JKEY",
  signal: new AbortController().signal,
  config: { calendars: ["primary"] },
  http: createHttp({ fetch: fetchFn, sleep: async () => {}, random: () => 0 }),
  secrets: memorySecrets({ token: "ntn_x" }),
  accessToken: async () => "ya29.test",
  ...extra,
});

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("Gmail drafts (acceptance #2: drafts only)", () => {
  const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

  it("creates a reply draft in the thread with reply headers and the idempotency header", async () => {
    const x = exchange([
      { url: `${GM}/drafts?maxResults=10`, body: { drafts: [] } },
      {
        url: `${GM}/threads/t1?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
        body: {
          messages: [
            { payload: { headers: [{ name: "Message-ID", value: "<a@x>" }] } },
            {
              payload: {
                headers: [
                  { name: "Message-Id", value: "<b@x>\r\nBcc: evil@x.com" },
                  { name: "References", value: "<a@x>" },
                ],
              },
            },
          ],
        },
      },
      {
        method: "POST",
        url: `${GM}/drafts`,
        body: { id: "d1", message: { id: "m9", threadId: "t1" } },
      },
    ]);
    const p = draftCreate.schema.parse({
      threadId: "t1",
      to: ["prof@uni.edu"],
      subject: "Re: Extension",
      body: "Dear Professor,\n\nCould I have until Friday?",
    });
    const out = await draftCreate.execute(p, ctx(x.fetch));
    expect(out).toMatchObject({ draftId: "d1", threadId: "t1" });
    const post = x.sent.find((s) => s.method === "POST");
    const body = JSON.parse(post?.body ?? "{}") as { message: { raw: string; threadId: string } };
    expect(body.message.threadId).toBe("t1");
    const raw = decode(body.message.raw);
    expect(raw).toContain("To: prof@uni.edu\r\n");
    expect(raw).toContain("X-Rocky-Key: 01JKEY\r\n");
    expect(raw).toContain("In-Reply-To: <b@x> Bcc: evil@x.com\r\n");
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain("References: <a@x> <b@x> Bcc: evil@x.com\r\n");
    // Only the draft endpoints are called: never a delivery endpoint.
    expect(x.sent.every((s) => !/\/send\b/.test(s.url))).toBe(true);
  });

  it("returns the earlier draft on retry (X-Rocky-Key found)", async () => {
    const x = exchange([
      {
        url: `${GM}/drafts?maxResults=10`,
        body: { drafts: [{ id: "d1", message: { id: "m9", threadId: "t1" } }] },
      },
      {
        url: `${GM}/drafts/d1?format=metadata`,
        body: { message: { payload: { headers: [{ name: "X-Rocky-Key", value: "01JKEY" }] } } },
      },
    ]);
    const p = draftCreate.schema.parse({ to: ["a@b.co"], subject: "Hi", body: "Text" });
    expect(await draftCreate.execute(p, ctx(x.fetch))).toMatchObject({
      draftId: "d1",
      reused: true,
    });
    expect(x.sent).toHaveLength(2);
  });

  it("updates a draft with PUT, encodes non-ASCII subjects, rejects header injection", async () => {
    const x = exchange([
      {
        method: "PUT",
        url: `${GM}/drafts/d1`,
        body: { id: "d1", message: { id: "m2", threadId: "t2" } },
      },
    ]);
    const p = draftUpdate.schema.parse({
      draftId: "d1",
      to: ["a@b.co"],
      subject: "Café plan",
      body: "x",
    });
    await draftUpdate.execute(p, ctx(x.fetch));
    expect(decode(JSON.parse(x.sent[0]?.body ?? "{}").message.raw)).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Café plan").toString("base64")}?=`,
    );
    expect(
      draftCreate.schema.safeParse({ to: ["a@b.co"], subject: "Hi\r\nBcc: x@y.z", body: "x" })
        .success,
    ).toBe(false);
    expect(
      draftCreate.schema.safeParse({ to: ["not an address"], subject: "Hi", body: "x" }).success,
    ).toBe(false);
  });

  it("wraps the body as base64 lines of at most 76 characters", () => {
    const raw = rfc2822(
      draftCreate.schema.parse({ to: ["a@b.co"], subject: "S", body: "x".repeat(300) }),
      "k",
    );
    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(body.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString()).toBe("x".repeat(300));
  });
});

describe("Calendar events", () => {
  const EV = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const base = {
    summary: "Office hours",
    start: { dateTime: "2026-10-20T10:00:00+05:30" },
    end: { dateTime: "2026-10-20T10:30:00+05:30" },
  };

  it("creates with an id derived from the key and no invitations by default", async () => {
    const id = eventIdFor("01JKEY");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    const x = exchange([
      { method: "POST", url: `${EV}?sendUpdates=none`, body: { id, htmlLink: "https://cal/e" } },
    ]);
    const p = eventCreate.schema.parse({ ...base, attendees: ["ta@uni.edu"] });
    expect(typeof eventCreate.risk === "function" && eventCreate.risk(p)).toBe("high");
    expect(await eventCreate.execute(p, ctx(x.fetch))).toEqual({
      eventId: id,
      url: "https://cal/e",
    });
    expect(JSON.parse(x.sent[0]?.body ?? "{}")).toMatchObject({
      id,
      summary: "Office hours",
      attendees: [{ email: "ta@uni.edu" }],
    });
  });

  it("a 409 on retry returns the event that already exists", async () => {
    const id = eventIdFor("01JKEY");
    const x = exchange([
      {
        method: "POST",
        url: `${EV}?sendUpdates=none`,
        status: 409,
        body: { error: { code: 409 } },
      },
      { url: `${EV}/${id}`, body: { id, htmlLink: "https://cal/e" } },
    ]);
    const p = eventCreate.schema.parse(base);
    expect(typeof eventCreate.risk === "function" && eventCreate.risk(p)).toBe("medium");
    expect(await eventCreate.execute(p, ctx(x.fetch))).toMatchObject({ eventId: id, reused: true });
  });

  it("patches with sendUpdates=all only when asked, and refuses unconfigured calendars", async () => {
    const x = exchange([
      { method: "PATCH", url: `${EV}/ev1?sendUpdates=all`, body: { id: "ev1" } },
    ]);
    const p = eventPatch.schema.parse({ eventId: "ev1", summary: "Moved", notifyAttendees: true });
    expect(typeof eventPatch.risk === "function" && eventPatch.risk(p)).toBe("high");
    await eventPatch.execute(p, ctx(x.fetch));
    expect(JSON.parse(x.sent[0]?.body ?? "{}")).toEqual({ summary: "Moved" });
    await expect(
      eventCreate.execute(
        eventCreate.schema.parse({ ...base, calendarId: "other@x" }),
        ctx(x.fetch),
      ),
    ).rejects.toThrow(/not one of the calendars/);
    expect(
      eventCreate.schema.safeParse({
        ...base,
        start: { date: "2026-10-20", dateTime: "2026-10-20T10:00:00Z" },
      }).success,
    ).toBe(false);
  });
});

describe("Drive source pack", () => {
  const FILES = "https://www.googleapis.com/drive/v3/files";
  const UP = "https://www.googleapis.com/upload/drive/v3/files";
  const pack = {
    course: "CS201",
    week: "2026-W42",
    title: "CS201 week 42",
    html: "<h1>Week 42</h1>",
  };
  const search = (q: string) =>
    `${FILES}?q=${encodeURIComponent(q)}&pageSize=1&fields=${encodeURIComponent("files(id,webViewLink)")}`;

  it("creates its folder once, then uploads the HTML converted to a Google Doc", async () => {
    const p = sourcePackWrite.schema.parse(pack);
    const { packKey } = await import("../src/google/gdrive-pack.ts");
    const x = exchange([
      {
        url: search(
          `appProperties has { key='rockyPack' and value='${packKey(p)}' } and trashed=false`,
        ),
        body: { files: [] },
      },
      {
        url: search("appProperties has { key='rocky' and value='sourcepacks' } and trashed=false"),
        body: { files: [] },
      },
      { method: "POST", url: `${FILES}?fields=id`, body: { id: "fold1" } },
      {
        method: "POST",
        url: `${UP}?uploadType=multipart&fields=id,webViewLink`,
        body: { id: "doc1", webViewLink: "https://docs/d" },
      },
    ]);
    expect(await sourcePackWrite.execute(p, ctx(x.fetch))).toEqual({
      fileId: "doc1",
      url: "https://docs/d",
    });
    const upload = x.sent.at(-1);
    expect(upload?.headers["content-type"]).toMatch(/^multipart\/related; boundary=/);
    expect(upload?.body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(upload?.body).toContain('"parents":["fold1"]');
    expect(upload?.body).toContain("<h1>Week 42</h1>");
  });

  it("replaces the same week's Doc instead of adding another", async () => {
    const p = sourcePackWrite.schema.parse(pack);
    const { packKey } = await import("../src/google/gdrive-pack.ts");
    const x = exchange([
      {
        url: search(
          `appProperties has { key='rockyPack' and value='${packKey(p)}' } and trashed=false`,
        ),
        body: { files: [{ id: "doc1" }] },
      },
      {
        method: "PATCH",
        url: `${UP}/doc1?uploadType=multipart&fields=id,webViewLink`,
        body: { id: "doc1" },
      },
    ]);
    expect(await sourcePackWrite.execute(p, ctx(x.fetch))).toMatchObject({
      fileId: "doc1",
      replaced: true,
    });
  });
});

describe("Notion writes", () => {
  const N = "https://api.notion.com/v1";

  it("turns text into heading, bullet and paragraph blocks, capped at 100", () => {
    expect(toBlocks("# Plan\n\n- one\n- two\n\nA paragraph\nwith two lines")).toEqual([
      {
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: "Plan" } }] },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: "one" } }] },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: "two" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "A paragraph\nwith two lines" } }],
        },
      },
    ]);
    expect(toBlocks(Array.from({ length: 150 }, (_, i) => `p${i}`).join("\n\n"))).toHaveLength(100);
  });

  it("maps row values by the data source schema and rejects unknown properties", () => {
    const schema = {
      properties: {
        Name: { id: "t", type: "title" },
        Due: { id: "d", type: "date" },
        Status: { id: "s", type: "status" },
        Done: { id: "c", type: "checkbox" },
        Tags: { id: "m", type: "multi_select" },
      },
    };
    expect(
      toProperties(schema, { Due: "2026-10-20", Status: "Todo", Done: false, Tags: "a, b" }),
    ).toEqual({
      Due: { date: { start: "2026-10-20" } },
      Status: { status: { name: "Todo" } },
      Done: { checkbox: false },
      Tags: { multi_select: [{ name: "a" }, { name: "b" }] },
    });
    expect(() => toProperties(schema, { Nope: "x" })).toThrow(/no property "Nope"/);
  });

  it("creates a row, and on retry reuses the row this integration just made", async () => {
    const schema = {
      properties: { Task: { id: "t", type: "title" }, Due: { id: "d", type: "date" } },
    };
    const found = (results: unknown[]) => ({ results, next_cursor: null, has_more: false });
    const x = exchange([
      { url: `${N}/data_sources/ds1`, body: schema },
      { url: `${N}/users/me`, body: { id: "bot1" } },
      { method: "POST", url: `${N}/search`, body: found([]) },
      { method: "POST", url: `${N}/pages`, body: { id: "pg1", url: "https://notion.so/pg1" } },
    ]);
    const p = rowCreate.schema.parse({
      dataSourceId: "ds1",
      title: "Send deck",
      values: { Due: "2026-10-20" },
    });
    expect(await rowCreate.execute(p, ctx(x.fetch))).toEqual({
      pageId: "pg1",
      url: "https://notion.so/pg1",
    });
    expect(JSON.parse(x.sent.at(-1)?.body ?? "{}")).toEqual({
      parent: { data_source_id: "ds1" },
      properties: {
        Due: { date: { start: "2026-10-20" } },
        Task: { title: [{ type: "text", text: { content: "Send deck" } }] },
      },
    });

    const y = exchange([
      { url: `${N}/users/me`, body: { id: "bot1" } },
      {
        method: "POST",
        url: `${N}/search`,
        body: found([
          {
            id: "pg0",
            url: "https://notion.so/pg0",
            created_time: new Date().toISOString(),
            created_by: { id: "bot1" },
            parent: { type: "page_id", page_id: "par-1" },
            properties: { title: { type: "title", title: [{ plain_text: "Notes" }] } },
          },
        ]),
      },
    ]);
    const pc = pageCreate.schema.parse({ parentPageId: "par1", title: "Notes", body: "x" });
    expect(await pageCreate.execute(pc, ctx(y.fetch))).toEqual({
      pageId: "pg0",
      url: "https://notion.so/pg0",
      reused: true,
    });
  });
});

import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { permalink, plainText, slackConnector as slack } from "../src/slack/index.ts";

// Hand-built from the Web API reference (docs.slack.dev, 2026-10-07); fixture-only until a
// workspace is connected (Phase 7 live check).

const API = "https://slack.com/api";
const secrets = () => memorySecrets({ token: "xoxb-test" });
const config = { channels: [], backfillDays: 30 };
// 2026-10-06 09:00 and 15:30 UTC; 2026-10-07 08:00 UTC.
const T1 = "1791277200.000100";
const T2 = "1791300600.000200";
const T3 = "1791360000.000300";
const R1 = "1791278000.000150";

const users = {
  ok: true,
  members: [
    { id: "U1", name: "ana", profile: { display_name: "Ana" } },
    { id: "U2", name: "ravi", real_name: "Ravi K" },
  ],
};
const channels = {
  ok: true,
  channels: [
    { id: "C1", name: "launch", is_member: true },
    { id: "C2", name: "random", is_member: false },
  ],
};
const msg = (ts: string, user: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  ts,
  user,
  text,
  ...extra,
});

function common(oldest: string, history: unknown[], extra: Parameters<typeof replay>[0] = []) {
  return replay([
    {
      url: `${API}/auth.test`,
      body: { ok: true, url: "https://acme.slack.com/", team: "Acme", user: "rocky" },
    },
    { url: `${API}/users.list?limit=200`, body: users },
    {
      url: `${API}/conversations.list?types=public_channel%2Cprivate_channel&exclude_archived=true&limit=200`,
      body: channels,
    },
    {
      url: `${API}/conversations.history?channel=C1&oldest=${oldest}&limit=200`,
      body: { ok: true, messages: history },
    },
    ...extra,
  ]);
}

describe("Slack sync", () => {
  it("one document per channel-day, replies after their parent, permalinks per message", async () => {
    const since = Date.parse("2026-10-01T00:00:00Z");
    const r = common(
      String(since / 1000),
      [
        msg(T3, "U2", "Ship it <!here>"),
        msg(T2, "U1", "Docs at <https://acme.dev/launch|launch page> for <#C9|eng>"),
        msg(T1, "U1", "Who owns the checklist, <@U2>?", { reply_count: 1, thread_ts: T1 }),
        {
          type: "message",
          subtype: "channel_join",
          ts: "1791270000.0",
          user: "U2",
          text: "joined",
        },
      ],
      [
        {
          url: `${API}/conversations.replies?channel=C1&ts=${T1}&limit=200`,
          body: {
            ok: true,
            messages: [
              msg(T1, "U1", "Who owns the checklist, <@U2>?", { thread_ts: T1 }),
              msg(R1, "U2", "I do", { thread_ts: T1 }),
            ],
          },
        },
      ],
    );
    const res = await runSync(slack, { fetch: r.fetch, config, secrets: secrets(), since });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => [d.externalId, d.title, d.sourceType])).toEqual([
      ["C1:2026-10-06", "#launch on 2026-10-06", "chat"],
      ["C1:2026-10-07", "#launch on 2026-10-07", "chat"],
    ]);
    const d = res.documents[0];
    if (d?.body.kind !== "text") throw new Error("text body expected");
    expect(d.body.units?.map((u) => [u.anchor, u.heading, u.text])).toEqual([
      [
        { kind: "message", messageId: T1, threadId: "C1" },
        "From Ana at 09:00 UTC",
        "Who owns the checklist, @Ravi K?",
      ],
      [
        { kind: "message", messageId: R1, threadId: "C1" },
        "Reply from Ravi K at 09:13 UTC",
        "I do",
      ],
      [
        { kind: "message", messageId: T2, threadId: "C1" },
        "From Ana at 15:30 UTC",
        "Docs at launch page (https://acme.dev/launch) for #eng",
      ],
    ]);
    expect((d.meta?.messageUrls as Record<string, string> | undefined)?.[R1]).toBe(
      `https://acme.slack.com/archives/C1/p1791278000000150?thread_ts=${T1}&cid=C1`,
    );
    expect(res.cursor).toEqual({ C1: T3 });
  });

  it("an incremental sync re-reads from the start of the last seen day", async () => {
    const r = common(String(Date.parse("2026-10-07T00:00:00Z") / 1000), [
      msg("1791370000.000400", "U1", "New today"),
    ]);
    const res = await runSync(slack, {
      fetch: r.fetch,
      config,
      secrets: secrets(),
      cursor: { C1: T3 },
    });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => d.externalId)).toEqual(["C1:2026-10-07"]);
    expect(res.cursor).toEqual({ C1: "1791370000.000400" });
  });

  it("a revoked token or missing scope asks to reinstall", async () => {
    const r = replay([{ url: `${API}/auth.test`, body: { ok: false, error: "token_revoked" } }]);
    await expect(
      runSync(slack, { fetch: r.fetch, config, secrets: secrets() }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("cleans Slack markup and builds permalinks", () => {
    expect(plainText("a &amp; b &lt;3 <!channel> <mailto:x@y.z>", new Map())).toBe(
      "a & b <3 @channel <mailto:x@y.z>",
    );
    expect(permalink("https://acme.slack.com/", "C1", "1791277200.000100")).toBe(
      "https://acme.slack.com/archives/C1/p1791277200000100",
    );
  });
});

describe("Slack drafts", () => {
  it("approval makes no network call: the user posts the text", async () => {
    const [draft] = slack.actions?.() ?? [];
    if (!draft) throw new Error("action missing");
    let calls = 0;
    const ctx: ExecContext = {
      idempotencyKey: "k",
      signal: new AbortController().signal,
      config,
      http: createHttp({
        fetch: (async () => {
          calls++;
          return new Response("{}");
        }) as typeof fetch,
      }),
      secrets: secrets(),
    };
    const out = await draft.execute(
      draft.schema.parse({ channel: "C1", threadTs: T1, text: "On it today." }),
      ctx,
    );
    expect(out).toEqual({
      text: "On it today.",
      open: "https://slack.com/app_redirect?channel=C1",
      threadTs: T1,
      posted: false,
    });
    expect(calls).toBe(0);
  });
});

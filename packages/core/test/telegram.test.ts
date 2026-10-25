// Telegram (roadmap A3, D-066): the Bot API wire format, long polling and what the bot answers.
import type { ActionRecord, AskResult } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import {
  answerText,
  approveData,
  parseApproveData,
  sendMessageBody,
  TelegramBot,
  type TelegramBotDeps,
  TelegramPoller,
  toInbound,
} from "../src/index.ts";

const HASH = "9f2c4b1e7a0d3c5f8e6b2a4d1c9e7f3a5b8d0c2e4f6a8b1d3c5e7f9a0b2c4d6e";
const draft = (over: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    id: "01JAPPROVAL000000000000001",
    title: "Create Gmail draft",
    description: { target: "dana@acme.dev", summary: "Re: annual plan" },
    payloadHash: HASH,
    risk: "low",
    status: "draft",
    review: "standard",
    actionClass: "write",
    ...over,
  }) as ActionRecord;

const found: AskResult = {
  answer: [
    {
      i: 0,
      text: "Dana agreed to the annual plan.",
      status: "supported",
      citations: [
        {
          chunkId: "c1",
          documentId: "d1",
          title: "Pricing call, 7 Oct",
          anchor: { kind: "text" },
          quote: "Dana agreed",
        },
      ],
    },
  ],
  notFound: false,
  closestMatches: [],
  path: null,
  verifierPath: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
} as unknown as AskResult;

function bot(over: Partial<TelegramBotDeps> = {}) {
  const sent: { chatId: number; text: string; buttons?: unknown[] }[] = [];
  const answered: string[] = [];
  const approved: string[] = [];
  const asked: string[] = [];
  let settings = {
    approveLowRiskInChat: false,
    phoneHost: "pc.tail1234.ts.net" as string | undefined,
  };
  const b = new TelegramBot({
    send: async (m) => void sent.push(m),
    answerCallback: async (_id, text) => void answered.push(text),
    settings: () => settings,
    drafts: () => [draft()],
    approve: (id) => {
      approved.push(id);
      return draft({ status: "approved" });
    },
    ask: async (q) => {
      asked.push(q);
      return found;
    },
    status: () => ({ running: 1, approvals: 1, unread: 3 }),
    today: () => ({ events: 2, dueSoon: 1, overdue: 0 }),
    ...over,
  });
  return {
    b,
    sent,
    answered,
    approved,
    asked,
    set: (s: Partial<typeof settings>) => {
      settings = { ...settings, ...s };
    },
  };
}

const msg = (text: string) => ({ kind: "message" as const, fromId: 42, chatId: 42, text });
const tap = (data: string) => ({
  kind: "callback" as const,
  fromId: 42,
  chatId: 42,
  callbackId: "cb1",
  data,
});

describe("Bot API wire format", () => {
  it("hands on only allowed users' private messages; a stranger's /start is reported by ID only", () => {
    const update = (from: number, text: string, type = "private") => ({
      update_id: 1,
      message: { from: { id: from, username: "dana" }, chat: { id: from, type }, text },
    });
    expect(toInbound(update(42, "hello"), [42])).toEqual({
      kind: "message",
      fromId: 42,
      chatId: 42,
      text: "hello",
    });
    expect(toInbound(update(7, "hello"), [42])).toBeNull();
    expect(toInbound(update(7, "/start"), [42])).toEqual({
      kind: "stranger",
      fromId: 7,
      name: "dana",
    });
    expect(toInbound(update(42, "hello", "group"), [42])).toBeNull();
    const cb = {
      update_id: 2,
      callback_query: { id: "q", from: { id: 7 }, data: "ap:x", message: { chat: { id: 7 } } },
    };
    expect(toInbound(cb, [42])).toBeNull();
    expect(toInbound(cb, [7])).toMatchObject({ kind: "callback", callbackId: "q", data: "ap:x" });
  });

  it("sends plain text (no markup parsing), trims to 4,096 characters, drops oversized button data", () => {
    const body = sendMessageBody({
      chatId: 42,
      text: "x".repeat(5000),
      buttons: [
        { text: "Review", url: "https://pc.tail1234.ts.net/approvals" },
        { text: "Bad", data: "y".repeat(65) },
      ],
    });
    expect(body).not.toHaveProperty("parse_mode");
    expect((body.text as string).length).toBe(4096);
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Review", url: "https://pc.tail1234.ts.net/approvals" }]],
    });
  });

  it("approval buttons fit in 64 bytes and only parse when well formed", () => {
    const d = approveData("01JAPPROVAL000000000000001", HASH);
    expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64);
    expect(parseApproveData(d)).toEqual({
      actionId: "01JAPPROVAL000000000000001",
      hashPrefix: HASH.slice(0, 16),
    });
    expect(parseApproveData("ap:../../x:0000")).toBeNull();
  });

  it("polls with the offset past the last update, and asks nothing without a token", async () => {
    const bodies: Record<string, unknown>[] = [];
    let batch = [{ update_id: 10, message: { from: { id: 42 }, chat: { id: 42 }, text: "hi" } }];
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/api\.telegram\.org\/botTOKEN\/getUpdates$/);
      bodies.push(JSON.parse(String(init.body)));
      const result = batch;
      batch = [];
      return Response.json({ ok: true, result });
    }) as unknown as typeof globalThis.fetch;
    const seen: unknown[] = [];
    let token: string | null = "TOKEN";
    const p = new TelegramPoller({
      fetch,
      token: () => token,
      allowed: () => [42],
      onInbound: (m) => seen.push(m),
    });
    expect(await p.tick()).toBe(1);
    expect(await p.tick()).toBe(0);
    expect(bodies.map((b) => b.offset)).toEqual([0, 11]);
    expect(bodies[0]).toMatchObject({
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });
    expect(seen).toHaveLength(1);
    token = null;
    expect(await p.tick()).toBeNull();
    expect(bodies).toHaveLength(2);
  });

  it("reports Telegram's own error, never the URL with the token", async () => {
    const fetch = (async () =>
      Response.json({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      })) as unknown as typeof globalThis.fetch;
    const p = new TelegramPoller({
      fetch,
      token: () => "SECRET",
      allowed: () => [],
      onInbound: () => {},
    });
    await expect(p.tick()).rejects.toThrow("Unauthorized");
    await expect(p.tick()).rejects.not.toThrow(/SECRET/);
  });
});

describe("TelegramBot", () => {
  it("answers a question with the verified sentences and their sources", async () => {
    const t = bot();
    await t.b.handle(msg("What did Dana agree to?"));
    expect(t.asked).toEqual(["What did Dana agree to?"]);
    expect(t.sent.at(-1)?.text).toBe(
      "Dana agreed to the annual plan.\n\nSources: Pricing call, 7 Oct",
    );
    expect(answerText({ ...found, answer: [], notFound: true })).toBe("Not found in your sources.");
  });

  it("knows /start, /status, /today and /approvals; unknown commands get help, not a question", async () => {
    const t = bot();
    await t.b.handle(msg("/status"));
    expect(t.sent.at(-1)?.text).toBe(
      "1 waiting for your approval, 1 running, 3 unread notifications.",
    );
    await t.b.handle(msg("/today"));
    expect(t.sent.at(-1)?.text).toContain("2 on your calendar");
    await t.b.handle(msg("/deleteeverything"));
    expect(t.sent.at(-1)?.text).toMatch(/can't send, change or delete/);
    expect(t.asked).toEqual([]);
  });

  it("lists approvals with a summary, the hash and a Review link; no Approve unless switched on", async () => {
    const t = bot();
    await t.b.handle(msg("/approvals"));
    const m = t.sent.at(-1);
    expect(m?.text).toContain("Create Gmail draft: Re: annual plan");
    expect(m?.text).toContain(`hash ${HASH.slice(0, 12)}`);
    expect(m?.buttons).toEqual([{ text: "Review", url: "https://pc.tail1234.ts.net/approvals" }]);
    t.set({ approveLowRiskInChat: true });
    await t.b.handle(msg("/approvals"));
    expect(t.sent.at(-1)?.buttons).toContainEqual({
      text: "Approve",
      data: approveData(draft().id, HASH),
    });
  });

  it("approves from a tap only when still allowed and unchanged", async () => {
    const t = bot();
    const data = approveData(draft().id, HASH);
    await t.b.handle(tap(data));
    expect(t.approved).toEqual([]); // the setting is off
    expect(t.answered.at(-1)).toBe("Approve this one in Rocky.");
    t.set({ approveLowRiskInChat: true });
    await t.b.handle(tap(approveData(draft().id, "0".repeat(64))));
    expect(t.answered.at(-1)).toMatch(/changed since/);
    await t.b.handle(tap(data));
    expect(t.approved).toEqual([draft().id]);
    expect(t.sent.at(-1)?.text).toMatch(/runs in 10 seconds/);
  });

  it("one question at a time", async () => {
    let release: () => void = () => {};
    const t = bot({
      ask: () =>
        new Promise((r) => {
          release = () => r(found);
        }),
    });
    const first = t.b.handle(msg("first"));
    await new Promise((r) => setTimeout(r, 0));
    await t.b.handle(msg("second"));
    expect(t.sent.at(-1)?.text).toMatch(/One at a time/);
    release();
    await first;
  });
});

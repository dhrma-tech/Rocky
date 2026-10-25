// Phone channels (roadmap A3, D-065): ntfy's wire format, what reaches the phone and in what words,
// and the daemon ↔ channel host wire.
import { type AppConfig, AppConfigSchema, type Notification } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChannelHostClient,
  type Db,
  fitMessage,
  InProcessChannelHost,
  memorySecrets,
  ntfyRequest,
  PhoneDispatcher,
  phoneMessage,
  phoneSkipReason,
  serveChannelHost,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const config = (over: Record<string, unknown> = {}): AppConfig =>
  AppConfigSchema.parse({
    daemon: { allowedHosts: ["pc.tail1234.ts.net"] },
    notifications: { ntfy: { enabled: true } },
    ...over,
  });

const note = (over: Partial<Notification> = {}): Notification => ({
  id: "01JN0000000000000000000001",
  at: 1000,
  kind: "needs_you",
  sentence: "Needs your approval: Draft a reply to Priya about the salary review",
  link: "/approvals",
  actionLabel: "Review",
  runId: "a1",
  readAt: null,
  snoozedUntil: null,
  ...over,
});

describe("ntfy wire format", () => {
  it("posts the text to <server>/<topic> with Title, Priority, Click and a Bearer token", () => {
    const { url, init } = ntfyRequest("https://ntfy.sh/", "rocky_x1", "tk_abc", {
      title: "Rocky needs you",
      text: "An approval is waiting for you.",
      click: "https://pc.tail1234.ts.net/approvals",
      priority: "high",
    });
    expect(url).toBe("https://ntfy.sh/rocky_x1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("An approval is waiting for you.");
    expect(init.headers).toMatchObject({
      Title: "Rocky needs you",
      Priority: "high",
      Click: "https://pc.tail1234.ts.net/approvals",
      Authorization: "Bearer tk_abc",
    });
    const plain = ntfyRequest("https://ntfy.sh", "t", null, {
      title: "Rocky",
      text: "x",
      priority: "default",
    });
    expect(plain.init.headers).not.toHaveProperty("Authorization");
    expect(plain.init.headers).not.toHaveProperty("Click");
  });

  it("keeps messages under ntfy's 4,096-byte limit without splitting a character", () => {
    const long = "é".repeat(5000);
    const out = fitMessage(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(3500);
    expect(out.endsWith("…")).toBe(true);
    expect(fitMessage("short")).toBe("short");
  });
});

describe("what reaches the phone", () => {
  it("says only the kind of thing unless details are on, and links to the phone's address", () => {
    const m = phoneMessage(note(), config());
    expect(m).toEqual({
      title: "Rocky needs you",
      text: "An approval is waiting for you.",
      click: "https://pc.tail1234.ts.net/approvals",
      priority: "high",
    });
    expect(m.text).not.toContain("Priya");
    const detailed = phoneMessage(
      note(),
      config({ notifications: { ntfy: { enabled: true, details: true } } }),
    );
    expect(detailed.text).toContain("Priya");
    expect(phoneMessage(note({ kind: "update", link: "/runs/r1" }), config())).toMatchObject({
      title: "Rocky",
      text: "Rocky finished something in the background.",
      priority: "default",
    });
    // No allowed name: no link to open.
    expect(phoneMessage(note(), config({ daemon: { allowedHosts: [] } }))).not.toHaveProperty(
      "click",
    );
  });

  it("is skipped in local-only mode, with ntfy off, for kinds kept in Rocky, and in quiet hours", () => {
    const at = (h: number) => new Date(2026, 9, 21, h);
    expect(phoneSkipReason(note(), config(), at(12))).toBeNull();
    expect(phoneSkipReason(note(), config({ localOnly: true }), at(12))).toBe("local-only");
    expect(
      phoneSkipReason(note(), config({ notifications: { ntfy: { enabled: false } } }), at(12)),
    ).toBe("no phone channel");
    expect(phoneSkipReason(note({ kind: "update" }), config(), at(12))).toBe("kept in Rocky");
    const quiet = config({
      notifications: {
        ntfy: { enabled: true },
        quietHours: { enabled: true, start: "22:00", end: "07:00" },
      },
    });
    expect(phoneSkipReason(note(), quiet, at(23))).toBe("quiet hours");
    expect(phoneSkipReason(note(), quiet, at(12))).toBeNull();
  });
});

describe("PhoneDispatcher", () => {
  let db: Db;
  beforeEach(() => {
    db = memoryDb();
  });
  afterEach(() => db.close());

  const fakeHost = (fail = false) => {
    const sent: unknown[] = [];
    return {
      sent,
      host: {
        sendNtfy: async (m: unknown) => {
          if (fail) throw new Error("ntfy answered 500.");
          sent.push(m);
        },
        sendTelegram: async () => {},
        answerCallback: async () => {},
        telegramIdentity: async () => "rocky_bot",
        setSecret: async () => {},
        deleteSecrets: async () => {},
        status: async () => ({
          ntfy: { topicSet: true, tokenSet: false },
          telegram: { tokenSet: false, bot: null, stranger: null },
        }),
        close: async () => {},
      },
    };
  };

  it("sends, and audits a hash of the text, never the text", async () => {
    const { host, sent } = fakeHost();
    const d = new PhoneDispatcher({
      db,
      host,
      config: () => config(),
      now: () => new Date(2026, 9, 21, 12),
    });
    expect(await d.dispatch(note())).toBe("sent");
    expect(sent).toHaveLength(1);
    const row = db
      .prepare("select * from audit_log where event_type = 'notification_sent'")
      .get() as {
      meta: string;
    };
    expect(row.meta).toMatch(/"textHash":"[0-9a-f]{64}"/);
    expect(JSON.stringify(row)).not.toContain("approval is waiting");
  });

  it("skips quietly when settings say so, and never throws when sending fails", async () => {
    const off = fakeHost();
    const local = new PhoneDispatcher({
      db,
      host: off.host,
      config: () => config({ localOnly: true }),
    });
    expect(await local.dispatch(note())).toBe("skipped");
    expect(off.sent).toEqual([]);
    const broken = new PhoneDispatcher({ db, host: fakeHost(true).host, config: () => config() });
    expect(await broken.dispatch(note())).toBe("failed");
  });
});

describe("channel host", () => {
  it("sends with the stored topic and token, and refuses in local-only mode or without a topic", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let cfg = config();
    const secrets = memorySecrets();
    const host = new InProcessChannelHost({ secrets, fetch, config: () => cfg });
    const m = { title: "Rocky", text: "hi", priority: "default" as const };
    await expect(host.sendNtfy(m)).rejects.toThrow(/No ntfy topic/);
    await host.setSecret("channel.ntfy-topic", "rocky_x1");
    await host.sendNtfy(m);
    expect(calls[0]?.url).toBe("https://ntfy.sh/rocky_x1");
    expect((await host.status()).ntfy).toEqual({ topicSet: true, tokenSet: false });
    cfg = config({ localOnly: true });
    await expect(host.sendNtfy(m)).rejects.toMatchObject({ code: "EGRESS_BLOCKED" });
    await host.deleteSecrets("ntfy");
    expect(secrets.list()).toEqual([]);
  });

  it("crosses the process wire: calls answer, errors keep their code", async () => {
    const toHost: ((m: unknown) => void)[] = [];
    const toDaemon: ((m: unknown) => void)[] = [];
    let cfg = config();
    const host = new InProcessChannelHost({
      secrets: memorySecrets({ "channel.ntfy-topic": "t" }),
      fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      config: () => cfg,
    });
    serveChannelHost(
      {
        send: (m) =>
          queueMicrotask(() => {
            for (const cb of toDaemon) cb(m);
          }),
        onMessage: (cb) => toHost.push(cb),
      },
      host,
    );
    const client = new ChannelHostClient({
      connect: () => ({
        send: (m) =>
          queueMicrotask(() => {
            for (const cb of toHost) cb(m);
          }),
        onMessage: (cb) => toDaemon.push(cb),
        close: () => {},
      }),
    });
    expect((await client.status()).ntfy.topicSet).toBe(true);
    await client.sendNtfy({ title: "Rocky", text: "x", priority: "default" });
    cfg = config({ localOnly: true });
    await expect(
      client.sendNtfy({ title: "Rocky", text: "x", priority: "default" }),
    ).rejects.toMatchObject({
      code: "EGRESS_BLOCKED",
    });
  });
});

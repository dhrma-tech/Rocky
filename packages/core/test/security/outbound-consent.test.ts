import type { AskEvent } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask, ConsentInvalid } from "../../src/assistant/ask.ts";
import type { Db } from "../../src/index.ts";
import { embedDocument } from "../../src/ingest/embed-job.ts";
import { markdownBlocks } from "../../src/ingest/parsers/text-blocks.ts";
import { upsertDocument } from "../../src/ingest/upsert.ts";
import { OutboundConsents, passagesHash } from "../../src/router/consent.ts";
import { CloudNeedsConsent, TaskNeedsCloud } from "../../src/router/errors.ts";
import { fakeEmbedder, memoryDb } from "../helpers.ts";
import { fakeProviders, HW_LOW, harness } from "../router-helpers.ts";

/**
 * Roadmap M4 (D-020, D-068), non-negotiable 3: under local first nothing leaves the computer
 * without the user's go-ahead, and a question never reaches the cloud before the user has seen
 * and accepted the exact passages it sends. The gate enforces it; the ask flow only asks.
 */

let db: Db;
const embedder = fakeEmbedder();
const RENEWAL =
  "# Vendor renewal\n\nThe Acme contract renews on March 1 at $12,000 per year. Write to legal@acme.example to cancel.";

async function add(id: string, title: string, body: string, localOnly = false) {
  const { text, blocks } = markdownBlocks(body);
  const res = upsertDocument(db, {
    parsed: {
      title,
      sourceType: "markdown",
      text,
      units: [{ anchor: { kind: "text" }, start: 0, end: text.length, blocks }],
    },
    externalId: id,
    createdAt: 1_000,
  });
  if (localOnly) db.prepare("update documents set local_only = 1 where id = ?").run(res.documentId);
  await embedDocument(db, embedder, res.documentId);
  return res.documentId;
}

const chunkId = () =>
  (db.prepare("select id from chunks where text like '%Acme%'").get() as { id: string }).id;
const isVerify = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("You check whether each claim");

/** Local model finds nothing; the cloud answers with a quoted, supported sentence. */
function world() {
  return fakeProviders((provider, body) => {
    if (isVerify(body)) return { labels: [{ i: 0, label: "SUPPORTED", reason: "quoted" }] };
    if (provider === "ollama") return { sentences: [], notFound: true };
    return {
      sentences: [
        {
          text: "The Acme contract renews on March 1.",
          citations: [chunkId()],
          quote: "The Acme contract renews on March 1",
        },
      ],
      notFound: false,
    };
  });
}

const cloudCalls = <T extends { url: string }>(calls: T[]) =>
  calls.filter((c) => c.url.includes("anthropic"));
const egressAudits = () =>
  db.prepare("select meta from audit_log where event_type = 'egress_blocked'").all() as {
    meta: string;
  }[];

beforeEach(async () => {
  db = memoryDb();
  await add("renewal", "Vendor renewal", RENEWAL);
});
afterEach(() => db.close());

describe("the gate under local first", () => {
  const call = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
    h.gate.call(
      {
        alias: "api:cheap",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        local: false,
        options: {},
      },
      {
        task: "chat",
        origin: "user_turn",
        system: "s",
        prompt: "p",
        maxTokens: 10,
        timeoutMs: 1000,
        ...extra,
      },
    );

  it("blocks a cloud call with no consent, audits it, and sends nothing", async () => {
    const { fetch, calls } = world();
    const h = harness(db, fetch, { mode: "local_first" });
    await expect(call(h)).rejects.toThrow(CloudNeedsConsent);
    await expect(call(h, { task: "extract", origin: "system" })).rejects.toThrow(CloudNeedsConsent);
    expect(calls).toHaveLength(0);
    expect(egressAudits().map((r) => JSON.parse(r.meta).reason)).toEqual([
      "local_first",
      "local_first",
    ]);
  });

  it("a made-up, offered-but-not-accepted, or background token gets nowhere", async () => {
    const { fetch, calls } = world();
    const h = harness(db, fetch, { mode: "local_first" });
    const { token } = h.consents.offer({
      question: "q",
      scopeKey: "{}",
      chunkIds: [],
      textHash: "h",
    });
    await expect(call(h, { cloudConsent: "f".repeat(32) })).rejects.toThrow(CloudNeedsConsent);
    await expect(call(h, { cloudConsent: token })).rejects.toThrow(CloudNeedsConsent);
    expect(h.consents.redeem(token, "q", "{}")).not.toBeNull();
    // Accepted, but background work can't borrow it.
    await expect(call(h, { cloudConsent: token, origin: "routine:x" })).rejects.toThrow(
      CloudNeedsConsent,
    );
    await expect(call(h, { cloudConsent: token, origin: "system" })).rejects.toThrow(
      CloudNeedsConsent,
    );
    expect(calls).toHaveLength(0);
    await call(h, { cloudConsent: token });
    expect(cloudCalls(calls)).toHaveLength(1);
    h.consents.finish(token);
    await expect(call(h, { cloudConsent: token })).rejects.toThrow(CloudNeedsConsent);
  });

  it("an accepted token expires", async () => {
    let now = 1_000_000;
    const { fetch, calls } = world();
    const h = harness(db, fetch, { mode: "local_first", now: () => now });
    const { token } = h.consents.offer({
      question: "q",
      scopeKey: "{}",
      chunkIds: [],
      textHash: "h",
    });
    h.consents.redeem(token, "q", "{}");
    now += 5 * 60_000;
    await expect(call(h, { cloudConsent: token })).rejects.toThrow(CloudNeedsConsent);
    expect(calls).toHaveLength(0);
  });

  it("the router keeps every task local, even on a low-RAM machine; cloud-only tasks say so", () => {
    const { fetch } = world();
    const h = harness(db, fetch, { mode: "local_first", hw: HW_LOW });
    expect(h.router.chain("chat").every((t) => t.local)).toBe(true);
    expect(h.router.chain("extract").every((t) => t.local)).toBe(true);
    expect(() => h.router.chain("draft")).toThrow(TaskNeedsCloud);
    // The key test sends no content: it may still check the key.
    expect(h.router.chain("key_test").some((t) => !t.local)).toBe(true);
  });
});

describe("the gate under cloud first", () => {
  it("a question's answer and check still need a preview; background work follows the policy", async () => {
    const { fetch, calls } = world();
    const h = harness(db, fetch, { mode: "cloud_first" });
    const target = {
      alias: "api:cheap",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      local: false,
      options: {},
    };
    const base = { system: "s", prompt: "p", maxTokens: 10, timeoutMs: 1000 };
    for (const task of ["chat", "verify"] as const)
      await expect(h.gate.call(target, { ...base, task, origin: "user_turn" })).rejects.toThrow(
        CloudNeedsConsent,
      );
    expect(calls).toHaveLength(0);
    await h.gate.call(target, { ...base, task: "verify", origin: "routine:brief" });
    await h.gate.call(target, { ...base, task: "draft", origin: "user_turn" });
    expect(cloudCalls(calls)).toHaveLength(2);
  });
});

describe("asking under local first", () => {
  const setup = () => {
    const w = world();
    const h = harness(db, w.fetch, { mode: "local_first" });
    const deps = {
      db,
      router: h.router,
      embedder,
      consents: h.consents,
      cloudReady: (p: string) => p === "anthropic",
    };
    return { ...w, h, deps };
  };
  const question = "When does the Acme contract renew?";

  it("answers locally; a weak answer offers the exact passages and sends nothing", async () => {
    const { calls, deps } = setup();
    const events: AskEvent[] = [];
    const r = await ask(deps, { question }, (e) => events.push(e));
    expect(r.notFound).toBe(true);
    expect(cloudCalls(calls)).toHaveLength(0);
    expect(r.outbound?.reason).toBe("not_found");
    expect(r.outbound?.model).toBe("anthropic/claude-sonnet-5-5");
    const text = (
      db.prepare("select text from chunks where id = ?").get(chunkId()) as { text: string }
    ).text;
    expect(r.outbound?.passages).toEqual([
      expect.objectContaining({ chunkId: chunkId(), text, tags: ["email"] }),
    ]);
    expect(events.map((e) => e.type)).toContain("outbound");
  });

  it("after consent, exactly those passages go to the cloud, once", async () => {
    const { calls, deps } = setup();
    const first = await ask(deps, { question });
    const token = first.outbound?.token ?? "";
    const r = await ask(deps, { question, consent: token });
    expect(r.notFound).toBe(false);
    expect(r.path).toMatchObject({ provider: "anthropic", local: false });
    const sent = cloudCalls(calls);
    // The answer and its check.
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0]?.body)).toContain("The Acme contract renews on March 1");
    const audits = db
      .prepare("select meta from audit_log where event_type = 'model_call'")
      .all()
      .map((x) => JSON.parse((x as { meta: string }).meta))
      .filter((m) => !m.local);
    expect(audits.every((m) => m.consented === true)).toBe(true);
    // One use only.
    await expect(ask(deps, { question, consent: token })).rejects.toThrow(ConsentInvalid);
    expect(cloudCalls(calls)).toHaveLength(2);
  });

  it("a different question, another scope, or a changed source voids the consent", async () => {
    const { calls, deps } = setup();
    const t1 = (await ask(deps, { question })).outbound?.token ?? "";
    await expect(ask(deps, { question: "Something else?", consent: t1 })).rejects.toThrow(
      ConsentInvalid,
    );
    const t2 = (await ask(deps, { question })).outbound?.token ?? "";
    await expect(
      ask(deps, { question, scope: { documentIds: ["x"] }, consent: t2 }),
    ).rejects.toThrow(ConsentInvalid);
    const t3 = (await ask(deps, { question })).outbound?.token ?? "";
    db.prepare("update chunks set text = text || ' Also: the secret plan.' where id = ?").run(
      chunkId(),
    );
    await expect(ask(deps, { question, consent: t3 })).rejects.toThrow(/sources changed/);
    expect(cloudCalls(calls)).toHaveLength(0);
  });

  it("picking the cloud shows the preview first and answers nothing", async () => {
    const { calls, deps } = setup();
    const r = await ask(deps, { question, route: "cloud" });
    expect(r).toMatchObject({ awaitingConsent: true, answer: [], path: null });
    expect(r.outbound?.reason).toBe("asked");
    expect(calls).toHaveLength(0);
  });

  it("never offers a local-only passage, or anything without a key", async () => {
    const { calls, deps } = setup();
    db.prepare("update documents set local_only = 1").run();
    const r = await ask(deps, { question, route: "cloud" });
    expect(r.outbound).toBeUndefined();
    expect(r.awaitingConsent).toBeUndefined();
    db.prepare("update documents set local_only = 0").run();
    const noKey = await ask({ ...deps, cloudReady: () => false }, { question, route: "cloud" });
    expect(noKey.outbound).toBeUndefined();
    expect(cloudCalls(calls)).toHaveLength(0);
  });
});

describe("the consent registry", () => {
  it("redeems once, for the same question and scope, before it expires", () => {
    let now = 0;
    const c = new OutboundConsents(() => now);
    const o = { question: "q", scopeKey: "{}", chunkIds: ["a"], textHash: passagesHash(["t"]) };
    const { token } = c.offer(o);
    expect(c.allows(token)).toBe(false);
    expect(c.redeem(token, "other", "{}")).toBeNull();
    expect(c.redeem(token, "q", '{"notebookIds":["n"]}')).toBeNull();
    expect(c.redeem(token, "q", "{}")).toEqual(o);
    expect(c.allows(token)).toBe(true);
    expect(c.redeem(token, "q", "{}")).toBeNull();
    const late = c.offer(o).token;
    now += 10 * 60_000;
    expect(c.redeem(late, "q", "{}")).toBeNull();
  });
});

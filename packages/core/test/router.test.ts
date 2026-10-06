import { type Task, TaskSchema } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Db } from "../src/index.ts";
import {
  BudgetExceeded,
  EgressBlocked,
  MissingApiKey,
  TaskNeedsApi,
  UnknownPrice,
} from "../src/router/errors.ts";
import { escalationLimits, evalTier, resolveChain } from "../src/router/policy.ts";
import { monthSpend } from "../src/router/prices.ts";
import { memoryDb } from "./helpers.ts";
import { fakeProviders, HW_GPU, HW_HIGH, HW_LOW, harness, realPolicy } from "./router-helpers.ts";

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

const Answer = z.object({ answer: z.string() });
const aliases = (task: Task, ctx: Parameters<typeof resolveChain>[2]) =>
  resolveChain(realPolicy(), task, ctx).map((t) => t.alias);

describe("policy resolution matrix", () => {
  const tasks = TaskSchema.options;

  it.each(tasks)("%s resolves on every RAM tier with local-only off", (task) => {
    for (const hw of [HW_LOW, HW_HIGH, HW_GPU])
      expect(aliases(task, { hardware: hw, localOnly: false }).length).toBeGreaterThan(0);
  });

  it.each(tasks)("%s under local-only is all-local or TaskNeedsApi", (task) => {
    for (const hw of [HW_LOW, HW_HIGH, HW_GPU]) {
      try {
        const chain = resolveChain(realPolicy(), task, { hardware: hw, localOnly: true });
        expect(chain.every((t) => t.local)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskNeedsApi);
      }
    }
  });

  it("applies the hardware tier and low-RAM API preference", () => {
    // No GPU: API first, local fallback (runs without a key or under local-only).
    expect(aliases("meeting_summary", { hardware: HW_HIGH, localOnly: false })).toEqual([
      "api:strong",
      "local:medium",
    ]);
    expect(aliases("extract", { hardware: HW_HIGH, localOnly: true })).toEqual(["local:medium"]);
    expect(aliases("meeting_summary", { hardware: HW_GPU, localOnly: false })).toEqual([
      "local:medium",
      "api:strong",
    ]);
    expect(aliases("tag", { hardware: HW_HIGH, localOnly: false })).toEqual([
      "local:small",
      "api:cheap",
    ]);
    expect(aliases("tag", { hardware: HW_LOW, localOnly: false })).toEqual(["api:cheap"]);
    expect(aliases("chat", { hardware: HW_HIGH, localOnly: true })).toEqual(["local:medium"]);
    expect(aliases("quiz_gen", { hardware: HW_HIGH, localOnly: false, examGrade: true })).toEqual([
      "api:strong",
    ]);
  });

  it("never runs propose_actions or draft locally", () => {
    expect(() =>
      resolveChain(realPolicy(), "propose_actions", { hardware: HW_GPU, localOnly: true }),
    ).toThrow(TaskNeedsApi);
    expect(() =>
      resolveChain(realPolicy(), "draft", { hardware: HW_GPU, localOnly: true }),
    ).toThrow(TaskNeedsApi);
  });

  it("honours a notebook override layered on top", () => {
    const p = realPolicy();
    p.tasks.chat = { primary: "local:small", escalate_on: [], local_allowed: true };
    expect(
      resolveChain(p, "chat", { hardware: HW_HIGH, localOnly: false }).map((t) => t.alias),
    ).toEqual(["local:small"]);
  });

  it("parses tier expressions and escalation rules", () => {
    expect(evalTier("tier(a if ram>=15 && gpu else b)", HW_GPU)).toBe("a");
    expect(evalTier("tier(a if ram>=15 && gpu else b)", HW_HIGH)).toBe("b");
    expect(
      escalationLimits({
        primary: "x",
        escalate_on: ["input_tokens>12000", "timeout_60s"],
        local_allowed: true,
      }),
    ).toEqual({ maxLocalInputTokens: 12000, timeoutMs: 60_000 });
  });

  it("passes qwen3.5 model options (reasoning off)", () => {
    const [t] = resolveChain(realPolicy(), "tag", { hardware: HW_HIGH, localOnly: false });
    expect(t?.options).toEqual({ reasoning_effort: "none" });
  });
});

describe("ProviderGate", () => {
  it("blocks API egress under global local-only before any request", async () => {
    const { fetch, calls } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch);
    h.settings.localOnly = true;
    const [api] = resolveChain(realPolicy(), "chat", { hardware: HW_HIGH, localOnly: false });
    await expect(
      h.gate.call(api as NonNullable<typeof api>, {
        task: "chat",
        origin: "user_turn",
        system: "s",
        prompt: "p",
        maxTokens: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(EgressBlocked);
    expect(calls).toHaveLength(0);
    expect(db.prepare("select event_type from audit_log").all()).toEqual([
      { event_type: "egress_blocked" },
    ]);
  });

  it("blocks at the budget cap with the numbers in the message", async () => {
    const { fetch, calls } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch);
    h.settings.monthlyCapUsd = 0.01;
    const err = await h.router
      .run({ task: "chat", origin: "user_turn", system: "s", prompt: "question", schema: Answer })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(err.message).toMatch(/\$0\.01/);
    expect(err.message).toMatch(/spent/);
    expect(calls).toHaveLength(0);
  });

  it("blocks models without a price while a cap is set", async () => {
    const { fetch } = fakeProviders(() => "x");
    const h = harness(db, fetch);
    const target = {
      alias: "x",
      provider: "anthropic",
      model: "claude-unknown",
      local: false,
      options: {},
    };
    await expect(
      h.gate.call(target, {
        task: "chat",
        origin: "system",
        system: "",
        prompt: "p",
        maxTokens: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(UnknownPrice);
  });

  it("records usage and an audit event without content", async () => {
    const { fetch } = fakeProviders(() => ({ answer: "secret-content-xyz" }));
    const h = harness(db, fetch);
    const r = await h.router.run({
      task: "chat",
      origin: "user_turn",
      system: "s",
      prompt: "private question text",
      schema: Answer,
    });
    expect(r.output).toEqual({ answer: "secret-content-xyz" });
    expect(r.path).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      local: false,
      attempts: 1,
    });
    expect(r.usage.costUsd).toBeCloseTo((2 * 1000 + 10 * 100) / 1e6);
    expect(monthSpend(db)).toBeCloseTo(r.usage.costUsd);
    const audit = db
      .prepare("select meta from audit_log where event_type = 'model_call'")
      .get() as { meta: string };
    expect(audit.meta).not.toMatch(/secret-content|private question/);
    expect(JSON.parse(audit.meta)).toMatchObject({
      task: "chat",
      provider: "anthropic",
      local: false,
    });
  });

  it("never sends temperature to Anthropic, but does to Ollama", async () => {
    const { fetch, calls } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch);
    await h.router.run({
      task: "chat",
      origin: "user_turn",
      system: "s",
      prompt: "p",
      schema: Answer,
      hints: { temperature: 0 },
    });
    expect(calls[0]?.body).not.toHaveProperty("temperature");
    await h.router.run({
      task: "tag",
      origin: "system",
      system: "s",
      prompt: "p",
      schema: Answer,
      hints: { temperature: 0 },
    });
    expect(calls.at(-1)?.body).toMatchObject({ temperature: 0, reasoning_effort: "none" });
  });
});

describe("Router fallback", () => {
  it("repairs once, then escalates to API after invalid JSON twice", async () => {
    const { fetch, calls } = fakeProviders((p) =>
      p === "ollama" ? "not json at all" : { answer: "from api" },
    );
    const h = harness(db, fetch);
    const r = await h.router.run({
      task: "tag",
      origin: "system",
      system: "s",
      prompt: "p",
      schema: Answer,
    });
    expect(r.output).toEqual({ answer: "from api" });
    expect(r.path).toMatchObject({
      provider: "anthropic",
      fallbackReason: "json_invalid_x2",
      attempts: 3,
    });
    expect(calls.filter((c) => c.url.includes("11434"))).toHaveLength(2);
  });

  it("falls back to local when the API key is missing", async () => {
    const { fetch } = fakeProviders(() => ({ answer: "local" }));
    const h = harness(db, fetch, { withKey: false });
    const r = await h.router.run({
      task: "chat",
      origin: "user_turn",
      system: "s",
      prompt: "p",
      schema: Answer,
    });
    expect(r.path).toMatchObject({
      provider: "ollama",
      local: true,
      fallbackReason: "missing_api_key",
    });
  });

  it("surfaces MissingApiKey when there is no local route", async () => {
    const { fetch } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch, { withKey: false });
    await expect(
      h.router.run({
        task: "draft",
        origin: "user_turn",
        system: "s",
        prompt: "p",
        schema: Answer,
      }),
    ).rejects.toThrow(MissingApiKey);
  });

  it("escalates past local when the input is over the local token limit", async () => {
    const { fetch } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch, { hw: HW_GPU });
    const r = await h.router.run({
      task: "meeting_summary",
      origin: "system",
      system: "s",
      prompt: "x".repeat(40_000),
      schema: Answer,
    });
    expect(r.path).toMatchObject({ local: false, fallbackReason: "input_tokens>12000" });
  });
});

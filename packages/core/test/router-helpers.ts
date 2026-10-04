import path from "node:path";
import type { Hardware } from "@rocky/contracts";
import { ProviderGate } from "../src/router/gate.ts";
import { loadPolicy, type PolicyFile } from "../src/router/policy.ts";
import type { PriceTable } from "../src/router/prices.ts";
import { Router } from "../src/router/router.ts";
import { memorySecrets } from "../src/secrets/keychain.ts";
import type { Db } from "../src/store/db.ts";

export const HW_HIGH: Pick<Hardware, "ramGb" | "ramTier" | "gpus" | "cuda"> = {
  ramGb: 15.7,
  ramTier: "high",
  gpus: ["Intel UHD"],
  cuda: false,
};
export const HW_LOW: typeof HW_HIGH = { ramGb: 8, ramTier: "low", gpus: [], cuda: false };
export const HW_GPU: typeof HW_HIGH = { ramGb: 32, ramTier: "high", gpus: ["RTX"], cuda: true };

/** The repo's real policy file, loaded from a data dir without overrides. */
export const realPolicy = (): PolicyFile =>
  loadPolicy(path.join(import.meta.dirname, "no-such-data-dir"));

export const PRICES: PriceTable = {
  "anthropic/claude-sonnet-5-5": { input: 2, output: 10 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
};

export interface FakeCall {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Fake HTTP for every provider. `reply(provider, body)` returns the model's text (or an object
 * that is JSON-encoded). Responses follow the real wire formats closely enough for the AI SDK.
 */
export function fakeProviders(
  reply: (provider: "anthropic" | "ollama" | "google", body: Record<string, unknown>) => unknown,
) {
  const calls: FakeCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const provider = url.includes("anthropic")
      ? "anthropic"
      : url.includes("googleapis")
        ? "google"
        : "ollama";
    const out = reply(provider, body);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    let payload: unknown;
    if (provider === "anthropic") {
      const tools = (body.tools as { name: string }[] | undefined) ?? [];
      const content = tools.length
        ? [{ type: "tool_use", id: "t1", name: tools[0]?.name, input: JSON.parse(text) }]
        : [{ type: "text", text }];
      payload = {
        id: "m",
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: tools.length ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
      };
    } else if (provider === "google") {
      payload = {
        candidates: [
          { content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 },
        ],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 },
      };
    } else {
      payload = {
        id: "c",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export interface Harness {
  router: Router;
  gate: ProviderGate;
  settings: { localOnly: boolean; monthlyCapUsd: number; ollamaBaseUrl: string };
}

export function harness(
  db: Db,
  fetch: typeof globalThis.fetch,
  opts: { hw?: typeof HW_HIGH; withKey?: boolean } = {},
): Harness {
  const settings = { localOnly: false, monthlyCapUsd: 10, ollamaBaseUrl: "http://127.0.0.1:11434" };
  const gate = new ProviderGate(db, {
    settings: () => settings,
    prices: () => PRICES,
    secrets: memorySecrets(opts.withKey === false ? {} : { anthropic: "sk-ant-test-key-123456" }),
    fetch,
  });
  const policy = realPolicy();
  const router = new Router({
    gate,
    policy: () => policy,
    hardware: () => opts.hw ?? HW_HIGH,
    globalLocalOnly: () => settings.localOnly,
  });
  return { router, gate, settings };
}

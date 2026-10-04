// Spike 6: AI SDK v7 structured output through Anthropic and Google providers.
// No network and no real key: an injected fetch records the request and returns a canned response.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Answer = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });
const payload = { answer: "Tiered pricing", confidence: 0.9 };

interface Recorded {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (body: Record<string, unknown>) => unknown) {
  const calls: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    return new Response(JSON.stringify(respond(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("spike: ai-sdk providers", () => {
  it("anthropic returns a schema-valid object and sends the passed key", async () => {
    const { fetch, calls } = fakeFetch((body) => {
      const tools = (body.tools as { name: string }[] | undefined) ?? [];
      const content = tools.length
        ? [{ type: "tool_use", id: "t1", name: tools[0]?.name, input: payload }]
        : [{ type: "text", text: JSON.stringify(payload) }];
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content,
        stop_reason: tools.length ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      };
    });
    const anthropic = createAnthropic({ apiKey: "sk-test-anthropic", fetch });
    const res = await generateText({
      model: anthropic("test-model"),
      output: Output.object({ schema: Answer }),
      prompt: "What did we decide about pricing?",
    });
    expect(res.output).toEqual(payload);
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-test-anthropic");
    expect(res.usage.inputTokens).toBe(12);
    console.info("anthropic structured-output mode:", calls[0]?.body.tools ? "tool" : "native");
  });

  it("google returns a schema-valid object and sends the passed key", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
    }));
    const google = createGoogleGenerativeAI({ apiKey: "g-test-key", fetch });
    const res = await generateText({
      model: google("test-model"),
      output: Output.object({ schema: Answer }),
      prompt: "What did we decide about pricing?",
    });
    expect(res.output).toEqual(payload);
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("g-test-key");
    expect(calls[0]?.url).not.toContain("g-test-key");
  });

  it("rejects output that violates the schema", async () => {
    const { fetch } = fakeFetch(() => ({
      candidates: [
        {
          content: { role: "model", parts: [{ text: '{"answer":"x","confidence":7}' }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
    const google = createGoogleGenerativeAI({ apiKey: "k", fetch });
    await expect(
      generateText({
        model: google("test-model"),
        output: Output.object({ schema: Answer }),
        prompt: "x",
      }),
    ).rejects.toThrow();
  });
});

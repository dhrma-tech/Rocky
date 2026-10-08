// Roadmap A8: only installed models are recommended; fit follows RAM; speed is measured.
import { describe, expect, it } from "vitest";
import {
  benchModel,
  cachedEmbedder,
  fitOf,
  listLocalModels,
  recommendModels,
} from "../src/index.ts";

const m = (name: string, sizeGb: number, canAnswer = true) => ({
  name,
  sizeGb,
  parameters: null,
  quantization: null,
  canAnswer,
});
const HW = { ramGb: 16, cuda: false };

describe("fit", () => {
  it("fits under 45% of RAM, is tight under 60%, too big above", () => {
    expect(fitOf(m("a", 7.2), HW).fit).toBe("fits");
    expect(fitOf(m("b", 9), HW).fit).toBe("tight");
    expect(fitOf(m("c", 10), HW)).toMatchObject({
      fit: "too-big",
      why: expect.stringContaining("63%"),
    });
  });
});

describe("recommendModels", () => {
  it("small is the smallest answering model, medium the largest that fits; rocky-* wins ties", () => {
    const r = recommendModels(HW, [
      m("nomic-embed-text", 0.3, false),
      m("qwen3.5:4b", 3.2),
      m("rocky-qwen3.5-4b-16k", 3.2),
      m("big:14b", 9),
      m("mid:8b", 5.5),
    ]);
    expect(r.small).toBe("rocky-qwen3.5-4b-16k");
    expect(r.medium).toBe("mid:8b");
  });

  it("says plainly when nothing can answer or nothing fits", () => {
    expect(recommendModels(HW, [m("nomic-embed-text", 0.3, false)])).toMatchObject({
      small: null,
      medium: null,
      note: expect.stringMatching(/No answering model/),
    });
    expect(recommendModels(HW, [m("huge:70b", 40)]).note).toMatch(/too big/);
  });
});

describe("Ollama calls", () => {
  it("lists models without internal llamacpp blobs or :latest duplicates", async () => {
    const f = (async () =>
      Response.json({
        models: [
          { name: "rocky-qwen3.5-4b-16k:latest", size: 3.4e9, capabilities: ["completion"] },
          { name: `llamacpp:${"a".repeat(64)}`, size: 3.4e9 },
          { name: "rocky-qwen3.5-4b-16k:latest", size: 3.4e9, capabilities: ["completion"] },
          { name: "nomic-embed-text:latest", size: 2.7e8, capabilities: ["embedding"] },
        ],
      })) as unknown as typeof fetch;
    const list = await listLocalModels("http://127.0.0.1:11434", f);
    expect(list.map((x) => [x.name, x.canAnswer])).toEqual([
      ["rocky-qwen3.5-4b-16k", true],
      ["nomic-embed-text", false],
    ]);
  });

  it("bench turns Ollama's timings into a speed profile, thinking off", async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_u: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        eval_count: 64,
        eval_duration: 8e9,
        prompt_eval_count: 500,
        prompt_eval_duration: 10e9,
        load_duration: 2e9,
      });
    }) as unknown as typeof fetch;
    const p = await benchModel("http://127.0.0.1:11434", "x", HW, { fetch: f, now: () => 5 });
    expect(sent).toMatchObject({ model: "x", stream: false, think: false });
    expect(p).toMatchObject({
      tokensPerSecond: 8,
      promptTokensPerSecond: 50,
      firstTokenMs: 12000,
      estimatedAnswerSeconds: 110,
      measuredAt: 5,
    });
  });
});

describe("cachedEmbedder", () => {
  it("embeds a repeated question once and never caches documents", async () => {
    const calls: [string[], string][] = [];
    const inner = {
      model: "e",
      dim: 2,
      embed: async (t: string[], k: "document" | "query") => {
        calls.push([t, k]);
        return t.map(() => new Float32Array([1, 2]));
      },
    };
    const e = cachedEmbedder(inner, 2);
    await e.embed(["what did we decide?"], "query");
    await e.embed(["what did we decide?"], "query");
    await e.embed(["doc"], "document");
    await e.embed(["doc"], "document");
    expect(calls).toEqual([
      [["what did we decide?"], "query"],
      [["doc"], "document"],
      [["doc"], "document"],
    ]);
  });
});

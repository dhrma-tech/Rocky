// First-run model download (roadmap A1, D-051): sized by RAM, progress parsed, policy updated.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicy } from "../src/router/policy.ts";
import { chooseStarter, pullModel, setupStarterModel } from "../src/system/starter.ts";
import { tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fake Ollama: /api/tags lists `installed`; /api/pull streams NDJSON in awkward chunks. */
function fakeOllama(installed: string[], pullLines: (model: string) => string[]) {
  const calls: { path: string; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/tags")
      return Response.json({ models: installed.map((name) => ({ name, size: 1e9 })) });
    if (url.pathname === "/api/pull") {
      const text = `${pullLines((body as { model: string }).model).join("\n")}\n`;
      // Split mid-line to prove lines are joined across chunks.
      const parts = [text.slice(0, 7), text.slice(7, 40), text.slice(40)];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(new TextEncoder().encode(p));
            c.close();
          },
        }),
      );
    }
    if (url.pathname === "/api/create") return new Response("{}");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const OK = [
  '{"status":"pulling manifest"}',
  '{"status":"pulling abc","total":100,"completed":40}',
  '{"status":"pulling abc","total":100,"completed":100}',
  '{"status":"success"}',
];

describe("chooseStarter", () => {
  it("picks the 4b model at 16 GB and the 2b model at 8 GB", () => {
    const policy = loadPolicy(dir);
    expect(chooseStarter(policy, { ramGb: 15.7 })?.pull).toBe("qwen3.5:4b");
    expect(chooseStarter(policy, { ramGb: 8 })?.pull).toBe("qwen3.5:2b");
  });
});

describe("pullModel", () => {
  it("reports progress and finishes on success", async () => {
    const { fetchFn } = fakeOllama([], () => OK);
    const seen: (number | undefined)[] = [];
    await pullModel("http://ollama", "qwen3.5:2b", (p) => seen.push(p.completed), fetchFn);
    expect(seen).toEqual([undefined, 40, 100, undefined]);
  });

  it("fails on an error line or a stream that ends early", async () => {
    const bad = fakeOllama([], () => ['{"status":"pulling"}', '{"error":"model not found"}']);
    await expect(pullModel("http://ollama", "nope:1b", () => {}, bad.fetchFn)).rejects.toThrow(
      /model not found/,
    );
    const short = fakeOllama([], () => ['{"status":"pulling manifest"}']);
    await expect(pullModel("http://ollama", "x", () => {}, short.fetchFn)).rejects.toThrow(
      /ended before it finished/,
    );
  });
});

describe("setupStarterModel", () => {
  it("pulls what is missing, makes the 16k copy and uses it for local answers", async () => {
    const { fetchFn, calls } = fakeOllama(["nomic-embed-text:latest"], () => OK);
    const r = await setupStarterModel({
      dataDir: dir,
      baseUrl: "http://ollama",
      policy: loadPolicy(dir),
      hardware: { ramGb: 8 },
      onProgress: () => {},
      fetchFn,
    });
    expect(r.model).toBe("rocky-qwen3.5-2b-16k");
    expect(calls.filter((c) => c.path === "/api/pull").map((c) => c.body)).toEqual([
      { model: "qwen3.5:2b", stream: true },
    ]);
    expect(calls.find((c) => c.path === "/api/create")?.body).toMatchObject({
      model: "rocky-qwen3.5-2b-16k",
      from: "qwen3.5:2b",
      parameters: { num_ctx: 16384 },
    });
    const after = loadPolicy(dir);
    expect(after.models["local:medium"]).toBe("ollama/rocky-qwen3.5-2b-16k");
    expect(after.model_options["ollama/rocky-qwen3.5-2b-16k"]).toEqual({
      reasoning_effort: "none",
    });
  });

  it("downloads nothing when everything is already there", async () => {
    const { fetchFn, calls } = fakeOllama(
      ["qwen3.5:4b", "rocky-qwen3.5-4b-16k", "nomic-embed-text"],
      () => OK,
    );
    await setupStarterModel({
      dataDir: dir,
      baseUrl: "http://ollama",
      policy: loadPolicy(dir),
      hardware: { ramGb: 16 },
      onProgress: () => {},
      fetchFn,
    });
    expect(calls.map((c) => c.path)).toEqual(["/api/tags"]);
  });

  it("says plainly when Ollama isn't running", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      setupStarterModel({
        dataDir: dir,
        baseUrl: "http://ollama",
        policy: loadPolicy(dir),
        hardware: { ramGb: 16 },
        onProgress: () => {},
        fetchFn: down,
      }),
    ).rejects.toThrow(/Ollama isn't running/);
  });
});

import fs from "node:fs";
import path from "node:path";
import { ingestPath, memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEmbedder, fixture, tempDir } from "../../../packages/core/test/helpers.ts";
import { fakeProviders, HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "t".repeat(64);
const bearer = { authorization: `Bearer ${TOKEN}` };

/** Chat answers with the first retrieved chunk's first sentence; the verifier supports it. */
function world() {
  const emb = fakeEmbedder();
  const models = fakeProviders((_p, body) => {
    const s = JSON.stringify(body);
    if (s.includes("You check whether each claim"))
      return { labels: [{ i: 0, label: "SUPPORTED", reason: "ok" }] };
    const m = /untrusted_data id=\\"([^\\]+)\\"[^>]*>\\n([^.]+)/.exec(s);
    if (!m) return { sentences: [], notFound: true };
    const quote = (m[2] as string).replace(/\\n/g, " ").trim();
    return { sentences: [{ text: quote, citations: [m[1]], quote }], notFound: false };
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/embed")) {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      const vecs = await emb.embed(texts, "document");
      return Response.json({ embeddings: vecs.map((v) => [...v]) });
    }
    return models.fetch(input, init);
  }) as typeof globalThis.fetch;
  return fetch;
}

let dir: string;
let rt: Runtime;
let app: Hono;
let auth: Auth;
let now = 1_000;

const req = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`${BASE}${p}`, {
    ...init,
    headers: { host: `127.0.0.1:${PORT}`, ...init.headers },
  });

async function session(): Promise<string> {
  const { code } = (await (
    await req("/api/v1/auth/codes", { method: "POST", headers: bearer })
  ).json()) as {
    code: string;
  };
  const res = await req(`/auth/bootstrap?code=${code}`);
  expect(res.status).toBe(302);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(";")[0] as string;
}

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets({ anthropic: "sk-ant-test-key-123456" }),
    fetch: world(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  now = 1_000;
  auth = new Auth({ token: TOKEN, port: PORT, now: () => now });
  app = createApp({ rt, auth });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("daemon exposure (SECURITY.md)", () => {
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await req("/api/v1/health", { headers: { host: `evil.example:${PORT}` } });
    expect(res.status).toBe(403);
    expect((await req("/api/v1/health", { headers: { host: "127.0.0.1:9999" } })).status).toBe(403);
    expect((await req("/api/v1/health")).status).toBe(200);
    expect((await req("/api/v1/health", { headers: { host: `localhost:${PORT}` } })).status).toBe(
      200,
    );
  });

  it("rejects any foreign Origin, even with a valid token", async () => {
    const res = await req("/api/v1/settings", {
      headers: { ...bearer, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("requires the token or a session on API routes", async () => {
    expect((await req("/api/v1/settings")).status).toBe(401);
    expect(
      (await req("/api/v1/settings", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect((await req("/api/v1/settings", { headers: bearer })).status).toBe(200);
  });

  it("bootstrap codes are single-use, expire after 60 s, and only the token can mint them", async () => {
    const cookie = await session();
    expect((await req("/api/v1/settings", { headers: { cookie } })).status).toBe(200);
    // A browser session cannot mint new codes.
    const mint = await req("/api/v1/auth/codes", {
      method: "POST",
      headers: { cookie, origin: BASE },
    });
    expect(mint.status).toBe(403);

    const code = auth.issueCode();
    expect((await req(`/auth/bootstrap?code=${code}`)).status).toBe(302);
    expect((await req(`/auth/bootstrap?code=${code}`)).status).toBe(401);
    const late = auth.issueCode();
    now += 61_000;
    expect((await req(`/auth/bootstrap?code=${late}`)).status).toBe(401);
  });

  it("cookie-authenticated writes need our Origin (CSRF)", async () => {
    const cookie = await session();
    const body = JSON.stringify({ localOnly: true });
    const put = (headers: Record<string, string>) =>
      req("/api/v1/settings", { method: "PUT", body, headers: { cookie, ...headers } });
    expect((await put({})).status).toBe(403);
    expect((await put({ origin: BASE })).status).toBe(200);
  });

  it("never returns stored secrets and refuses to overwrite the daemon token", async () => {
    const set = await req("/api/v1/secrets/google", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ value: "google-key-123" }),
    });
    expect(set.status).toBe(200);
    const settings = await (await req("/api/v1/settings", { headers: bearer })).text();
    expect(settings).not.toContain("google-key-123");
    expect(settings).not.toContain("sk-ant-test");
    expect(JSON.parse(settings).secrets).toMatchObject({ google: true, anthropic: true });
    const tok = await req("/api/v1/secrets/daemon-token", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ value: "x" }),
    });
    expect(tok.status).toBe(400);
  });
});

describe("API", () => {
  it("settings: PUT persists to rocky.yaml and applies to the gate immediately", async () => {
    const res = await req("/api/v1/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ localOnly: true, budget: { monthlyCapUsd: 3 } }),
    });
    expect(res.status).toBe(200);
    expect(rt.config.localOnly).toBe(true);
    expect(fs.readFileSync(path.join(dir, "rocky.yaml"), "utf8")).toMatch(/localOnly: true/);
    expect(rt.router.chain("chat").every((t) => t.local)).toBe(true);
    const bad = await req("/api/v1/settings", {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ dataDir: "C:/elsewhere" }),
    });
    expect(bad.status).toBe(400);
  });

  it("ingest → ask streams SSE events → anchor → blob range → delete", async () => {
    const corpus = path.join(dir, "corpus");
    fs.mkdirSync(corpus);
    fs.writeFileSync(
      path.join(corpus, "renewal.md"),
      "# Renewal\n\nThe CloudHost contract renews on November 1. Notice is 30 days.",
    );
    const ing = await req("/api/v1/ingest", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ path: corpus }),
    });
    expect(ing.status).toBe(200);
    await rt.drainJobs();

    const sse = await req("/api/v1/ask", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ question: "When does the CloudHost contract renew?" }),
    });
    expect(sse.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await sse.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(["retrieval", "draft_sentence", "verified", "done"]);
    const done = JSON.parse(/event: done\ndata: (.+)/.exec(text)?.[1] ?? "{}").result;
    expect(done.notFound).toBe(false);
    const cite = done.answer[0].citations[0];

    const anchor = (await (
      await req(`/api/v1/documents/${cite.documentId}/anchor?chunk=${cite.chunkId}`, {
        headers: bearer,
      })
    ).json()) as { text: string; charStart: number; charEnd: number };
    expect(anchor).toMatchObject({ viewer: "text", title: "Renewal" });
    expect(anchor.text.slice(anchor.charStart, anchor.charEnd)).toContain("CloudHost");

    const doc = (await (
      await req(`/api/v1/documents/${cite.documentId}`, { headers: bearer })
    ).json()) as { blobUrl: string };
    const range = await req(doc.blobUrl, { headers: { ...bearer, range: "bytes=2-8" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("Renewal");
    expect(range.headers.get("content-range")).toMatch(/^bytes 2-8\/\d+$/);

    const del = await req(`/api/v1/documents/${cite.documentId}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(del.status).toBe(200);
    expect((await req(doc.blobUrl, { headers: bearer })).status).toBe(404);
    expect(rt.db.prepare("select count(*) as n from chunks").get()).toEqual({ n: 0 });
    expect(rt.db.prepare("select count(*) as n from chunks_vec").get()).toEqual({ n: 0 });
    expect(rt.db.prepare("select count(*) as n from chunks_fts").get()).toEqual({ n: 0 });
  });

  it("streams policy errors as an SSE error event with their code", async () => {
    await ingestPath(rt.db, rt.paths.blobs, fixture("."));
    await rt.drainJobs();
    rt.config.budget.monthlyCapUsd = 0.000001;
    const text = await (
      await req("/api/v1/ask", {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ question: "What does the document say?" }),
      })
    ).text();
    expect(text).toMatch(/event: error\ndata: .*BUDGET_EXCEEDED/);
  });

  it("rejects malformed ask bodies", async () => {
    const res = await req("/api/v1/ask", { method: "POST", headers: bearer, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("serves the web build without escaping its folder", async () => {
    const web = path.join(dir, "web");
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Rocky</title>");
    fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");
    const withWeb = createApp({ rt, auth, webDir: web });
    const get = (p: string) =>
      withWeb.request(`${BASE}${p}`, { headers: { host: `127.0.0.1:${PORT}` } });
    expect(await (await get("/")).text()).toContain("<title>Rocky</title>");
    expect(await (await get("/ask")).text()).toContain("<title>Rocky</title>");
    expect(await (await get("/..%2fsecret.txt")).text()).not.toContain("do not serve");
    expect(await (await get("/%2e%2e/secret.txt")).text()).not.toContain("do not serve");
  });
});

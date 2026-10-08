import fs from "node:fs";
import { builtinConnectors } from "@rocky/connectors";
import type {
  ActionRecord,
  Connector,
  ConnectorCatalogEntry,
  ConnectorRun,
} from "@rocky/contracts";
import { memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEmbedder, tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { registerConnectors } from "../src/connectors.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);
const PAT = "github_pat_11ABCDEFG_secretvalue";

let dir: string;
let rt: Runtime;
let app: Hono;
let created: { title: string; body: string }[];
let ghCalls: string[];

const issue = {
  id: 1,
  number: 142,
  title: "Login fails on Safari",
  body: "Steps to reproduce…",
  state: "open",
  html_url: "https://github.com/o/r/issues/142",
  user: { login: "octo" },
  labels: [],
  comments: 1,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
};

/** A tiny fake GitHub plus the Ollama embed endpoint. */
function fakeFetch() {
  const emb = fakeEmbedder();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/api/embed")) {
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ embeddings: (await emb.embed(texts, "document")).map((v) => [...v]) });
    }
    if (url.host !== "api.github.com") throw new Error(`unexpected host ${url.host}`);
    ghCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${PAT}`)
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ login: "octo" });
    if (url.pathname === "/repos/o/r") return Response.json({ full_name: "o/r" });
    if (url.pathname === "/repos/o/r/issues" && init?.method === "POST") {
      const b = JSON.parse(String(init.body)) as { title: string; body: string };
      created.push(b);
      return Response.json(
        { ...issue, number: 143, html_url: "https://github.com/o/r/issues/143", ...b },
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/o/r/issues")
      return Response.json(url.searchParams.get("sort") === "created" ? [] : [issue]);
    if (url.pathname === "/repos/o/r/issues/142/comments")
      return Response.json([
        {
          id: 777,
          body: "We decided to drop Safari 15 support.",
          user: { login: "ana" },
          html_url: "https://github.com/o/r/issues/142#issuecomment-777",
          created_at: "2026-09-02T09:00:00Z",
        },
      ]);
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  dir = tempDir();
  created = [];
  ghCalls = [];
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    fetch: fakeFetch(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  await registerConnectors(rt);
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }) });
});
afterEach(async () => {
  await rt.connectors.idle();
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = async <T = unknown>(p: string, init: RequestInit = {}) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text };
};
const post = <T = unknown>(p: string, body?: unknown) =>
  req<T>(p, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function connectGithub() {
  expect((await post("/connectors", { kind: "github", config: { repos: ["o/r"] } })).status).toBe(
    201,
  );
  expect((await post("/connectors/github/secrets/token", { value: PAT })).body).toEqual({
    stored: true,
  });
  expect((await post<{ started: boolean }>("/connectors/github/sync")).status).toBe(202);
  await rt.connectors.idle();
  await rt.drainJobs();
}

describe("connectors API", () => {
  it("lists the built-in catalog with secret specs but never values", async () => {
    const cat = (await req<{ catalog: ConnectorCatalogEntry[] }>("/connectors/catalog")).body
      .catalog;
    expect(cat.map((c) => c.kind)).toEqual(builtinConnectors.map((c) => c.id));
    expect(cat.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["github", "notion", "gmail", "gcal", "gdrive"]),
    );
    expect(cat.find((c) => c.kind === "gmail")).toMatchObject({
      oauthGroup: "google-oauth",
      secrets: [],
    });
    expect(cat.find((c) => c.kind === "github")?.actions).toEqual([
      { type: "github.issueCreate", title: "Create GitHub issue" },
    ]);
  });

  it("sets up GitHub, syncs it, and never returns the token", async () => {
    expect(
      (await post("/connectors", { kind: "github", config: { repos: ["not a repo"] } })).status,
    ).toBe(400);
    await connectGithub();
    const list = await req<{ connectors: Connector[] }>("/connectors");
    expect(list.body.connectors[0]).toMatchObject({
      id: "github",
      status: "connected",
      documentCount: 1,
    });
    expect(list.text).not.toContain(PAT);
    expect((await req("/connectors/catalog")).text).not.toContain(PAT);
    const runs = await req<{ runs: ConnectorRun[] }>("/connectors/github/runs");
    expect(runs.body.runs[0]).toMatchObject({ status: "ok", added: 1, requests: 2 });
    expect((await post("/connectors/github/secrets/password", { value: "x" })).status).toBe(400);
    expect((await post("/connectors/nope/sync")).status).toBe(404);
    expect(
      (await post<{ status: string; account: string }>("/connectors/github/test")).body,
    ).toMatchObject({ status: "ok", account: "octo" });
  });

  it("opens a cited GitHub comment as an external deep link", async () => {
    await connectGithub();
    const chunk = rt.db
      .prepare("select c.id, c.document_id from chunks c where c.text like '%Safari 15%'")
      .get() as { id: string; document_id: string };
    const a = await req<{ viewer: string; url: string }>(
      `/documents/${chunk.document_id}/anchor?chunk=${chunk.id}`,
    );
    expect(a.body).toMatchObject({
      viewer: "external",
      url: "https://github.com/o/r/issues/142#issuecomment-777",
    });
  });

  it("creates an issue only after approval, through the queue, with audit entries (acceptance #4)", async () => {
    await connectGithub();
    const chunk = rt.db
      .prepare("select c.id, c.document_id, c.anchor from chunks c limit 1")
      .get() as {
      id: string;
      document_id: string;
      anchor: string;
    };
    const citation = {
      chunkId: chunk.id,
      documentId: chunk.document_id,
      title: "o/r#142",
      anchor: JSON.parse(chunk.anchor),
      quote: "Login fails",
    };
    expect(
      (
        await post("/actions", {
          type: "github.issueCreate",
          payload: { repo: "o/r", title: "x" },
          citations: [],
        })
      ).status,
    ).toBe(400);
    const proposed = await post<ActionRecord>("/actions", {
      type: "github.issueCreate",
      payload: { repo: "o/r", title: "Follow up: Safari login", body: "From Rocky" },
      citations: [citation],
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: "draft", risk: "medium" });
    expect(created).toEqual([]); // nothing runs until approved
    const id = proposed.body.id;
    expect((await post(`/actions/${id}/approve`, { payloadHash: "0".repeat(64) })).status).toBe(
      409,
    );
    // Drafted from a synced issue: strict review, so the right hash alone is not enough (I1).
    expect(proposed.body.review).toBe("strict");
    const unacked = await post(`/actions/${id}/approve`, {
      payloadHash: proposed.body.payloadHash,
    });
    expect(unacked.status).toBe(409);
    expect(JSON.stringify(unacked.body)).toContain("REVIEW_REQUIRED");
    expect(
      (
        await post(`/actions/${id}/approve`, {
          payloadHash: proposed.body.payloadHash,
          acknowledgeSources: true,
        })
      ).status,
    ).toBe(200);
    const done = await post<ActionRecord>(`/actions/${id}/execute`);
    expect(done.body).toMatchObject({ status: "executed", result: { number: 143 } });
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toContain(`<!-- rocky:${proposed.body.idempotencyKey} -->`);
    const events = (
      rt.db
        .prepare("select event_type from audit_log where subject_id = ? order by seq")
        .all(id) as { event_type: string }[]
    ).map((e) => e.event_type);
    expect(events).toEqual(["action_proposed", "action_approved", "action_executed"]);
  });

  it("disconnect with purge removes the synced documents and the token", async () => {
    await connectGithub();
    expect(
      (await req<{ purged: number }>("/connectors/github?purge=1", { method: "DELETE" })).body,
    ).toEqual({ purged: 1 });
    expect(rt.db.prepare("select count(*) n from documents").get()).toEqual({ n: 0 });
    expect(rt.secrets.list()).toEqual([]);
  });
});

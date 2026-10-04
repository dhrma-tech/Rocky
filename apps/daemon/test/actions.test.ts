import fs from "node:fs";
import type { ActionRecord, AuditRow } from "@rocky/contracts";
import { echoAction, memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { seedCitation } from "../../../packages/core/test/security/actions-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);

let dir: string;
let rt: Runtime;
let app: Hono;
let calls: ReturnType<typeof echoAction>["calls"];
let wiped = 0;

const call = async <T = unknown>(p: string, init: RequestInit = {}) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  return { status: res.status, body: (await res.json()) as T };
};
const post = <T = unknown>(p: string, body?: unknown) =>
  call<T>(p, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  const echo = echoAction();
  calls = echo.calls;
  rt.registry.register(echo.def);
  wiped = 0;
  app = createApp({
    rt,
    auth: new Auth({ token: TOKEN, port: PORT }),
    deleteEverything: async () => {
      wiped++;
    },
  });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const propose = (message = "open a ticket") =>
  rt.actions.propose({
    type: "test.echo",
    payload: { message },
    origin: "user_turn",
    citations: [seedCitation(rt.db)],
  });

describe("actions API", () => {
  it("lists, approves with the displayed hash, executes, and audits every step", async () => {
    const a = propose();
    const list = await call<{ actions: ActionRecord[] }>("/actions?status=draft");
    expect(list.body.actions.map((x) => x.id)).toEqual([a.id]);

    // An edit after the card was displayed invalidates the hash the UI holds.
    await call(`/actions/${a.id}`, {
      method: "PATCH",
      body: JSON.stringify({ payload: { message: "edited" } }),
    });
    const stale = await post<{ code: string }>(`/actions/${a.id}/approve`, {
      payloadHash: a.payloadHash,
    });
    expect(stale).toMatchObject({ status: 409, body: { code: "HASH_MISMATCH" } });
    const early = await post<{ code: string }>(`/actions/${a.id}/execute`);
    expect(early).toMatchObject({ status: 409, body: { code: "ILLEGAL_TRANSITION" } });
    expect(calls).toEqual([]);

    const fresh = await call<ActionRecord>(`/actions/${a.id}`);
    const ok = await post<ActionRecord>(`/actions/${a.id}/approve`, {
      payloadHash: fresh.body.payloadHash,
    });
    expect(ok.body.status).toBe("approved");
    const done = await post<ActionRecord>(`/actions/${a.id}/execute`);
    expect(done.body).toMatchObject({ status: "executed", result: { echoed: "edited" } });
    expect(calls).toHaveLength(1);

    const audit = await call<{ entries: AuditRow[] }>("/audit");
    expect(audit.body.entries.map((e) => e.eventType)).toEqual([
      "action_executed",
      "action_approved",
      "action_edited",
      "action_proposed",
    ]);
    expect(audit.body.entries[3]?.payload).toEqual({ message: "open a ticket" });
    expect((await post<{ ok: boolean }>("/audit/verify")).body.ok).toBe(true);
  });

  it("rejects bad requests and unknown ids", async () => {
    expect((await call("/actions?status=bogus")).status).toBe(400);
    expect((await call("/actions/nope")).status).toBe(404);
    const a = propose();
    expect((await post(`/actions/${a.id}/approve`, { payloadHash: "short" })).status).toBe(400);
    expect((await post(`/actions/${a.id}/reject`)).status).toBe(200);
    expect((await post(`/actions/${a.id}/reject`)).status).toBe(409);
  });

  it("paginates the audit log and filters by type", async () => {
    for (let i = 0; i < 5; i++) propose(`m${i}`);
    const page = await call<{ entries: AuditRow[]; nextCursor: number | null }>("/audit?limit=2");
    expect(page.body.entries).toHaveLength(2);
    const next = await call<{ entries: AuditRow[] }>(
      `/audit?limit=2&cursor=${page.body.nextCursor}`,
    );
    expect(next.body.entries[0]?.seq).toBeLessThan(page.body.entries[1]?.seq ?? 0);
    const typed = await call<{ entries: AuditRow[] }>("/audit?type=action_proposed");
    expect(typed.body.entries.every((e) => e.eventType === "action_proposed")).toBe(true);
  });
});

describe("deletion API", () => {
  it("needs the typed confirmation, deletes documents, and hands 'everything' to the daemon", async () => {
    const cite = seedCitation(rt.db);
    const target = { documentIds: [cite.documentId] };
    expect((await post("/deletion", { target })).status).toBe(400);
    expect((await post("/deletion", { target, confirm: "delete" })).status).toBe(400);
    const r = await post<{ documents: number }>("/deletion", { target, confirm: "DELETE" });
    expect(r).toMatchObject({ status: 200, body: { documents: 1 } });
    expect(rt.db.prepare("select count(*) as n from documents").get()).toEqual({ n: 0 });

    const all = await post("/deletion", { target: { everything: true }, confirm: "DELETE" });
    expect(all.status).toBe(202);
    await new Promise((r) => setTimeout(r, 80));
    expect(wiped).toBe(1);
  });
});

// /rules API (roadmap A4) and the approval hold on /actions/:id/approve (D-014).
import fs from "node:fs";
import type { ActionRecord, ActionRule, RulePreview } from "@rocky/contracts";
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

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  rt.registry.register(echoAction().def);
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }) });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async <T>(p: string, body?: unknown) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
};

const allowEcho = {
  effect: "allow",
  connectorId: null,
  actionType: "test.echo",
  actionClass: null,
  constraints: [{ field: "message", op: "equals", value: "ping" }],
  expiresAt: Date.now() + 86_400_000,
};

describe("rules API", () => {
  it("previews, refuses a blanket allow, creates, lists and revokes", async () => {
    const preview = await call<RulePreview>("/rules/preview", allowEcho);
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.sentence).toMatch(/^Rocky will echo \(test\) when message is "ping"/);

    const blanket = await call<{ code: string; error: string }>("/rules", {
      ...allowEcho,
      constraints: [],
      expiresAt: null,
    });
    expect(blanket.status).toBe(400);
    expect(blanket.body.code).toBe("INVALID_RULE");

    const created = await call<ActionRule>("/rules", allowEcho);
    expect(created.status).toBe(201);
    expect((await call<{ rules: ActionRule[] }>("/rules")).body.rules.map((r) => r.id)).toEqual([
      created.body.id,
    ]);
    const revoked = await call<ActionRule>(`/rules/${created.body.id}/revoke`, {});
    expect(revoked.body).toMatchObject({ active: false });
  });
});

describe("approve", () => {
  it("holds 10 s by default for Undo; Approve now sends holdMs 0", async () => {
    const propose = () =>
      rt.actions.propose({
        type: "test.echo",
        payload: { message: "hello" },
        origin: "user_turn",
        citations: [seedCitation(rt.db)],
      });
    const a = propose();
    const before = Date.now();
    const held = await call<ActionRecord>(`/actions/${a.id}/approve`, {
      payloadHash: a.payloadHash,
    });
    expect(held.body.executeAfter).toBeGreaterThanOrEqual(before + 10_000);
    const b = propose();
    const now = await call<ActionRecord>(`/actions/${b.id}/approve`, {
      payloadHash: b.payloadHash,
      holdMs: 0,
    });
    expect(now.body.executeAfter).toBeLessThanOrEqual(Date.now());
    expect(rt.actions.due()).toEqual([b.id]);
  });
});

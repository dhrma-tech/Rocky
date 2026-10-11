// /onboarding API (UI spec 3, D-048).
import fs from "node:fs";
import { memorySecrets, openRuntime, type Runtime } from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
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
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }) });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async <T>(method: string, p: string, body?: unknown) => {
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
};

describe("/onboarding", () => {
  it("reports a first run on an empty install and saves each step", async () => {
    const first = await call<{ step: number; firstRun: boolean }>("GET", "/onboarding");
    expect(first.body).toMatchObject({ step: 1, firstRun: true });
    const saved = await call("PATCH", "/onboarding", { step: 2, name: "Pip", swatch: "rose" });
    expect(saved.body).toMatchObject({ step: 2, name: "Pip", swatch: "rose" });
    const done = await call("PATCH", "/onboarding", { complete: true });
    expect(done.body).toMatchObject({ firstRun: false });
  });

  it("rejects unknown fields and colours outside the palette", async () => {
    expect((await call("PATCH", "/onboarding", { swatch: "#ff0000" })).status).toBe(400);
    expect((await call("PATCH", "/onboarding", { completedAt: 1 })).status).toBe(400);
  });

  it("Read only shows up as a rule", async () => {
    await call("PATCH", "/onboarding", { preset: "read-only" });
    const rules = await call<{ rules: { effect: string; active: boolean }[] }>("GET", "/rules");
    expect(rules.body.rules).toEqual([expect.objectContaining({ effect: "block", active: true })]);
  });

  it("the key test says no key is saved, without any network call", async () => {
    const r = await call("POST", "/onboarding/test-key");
    expect(r.body).toMatchObject({ ok: false, reason: "no-key" });
  });

  it("the key test respects local-only", async () => {
    await call("PUT", "/settings", { localOnly: true });
    rt.secrets.set("anthropic", "sk-test");
    const r = await call("POST", "/onboarding/test-key");
    expect(r.body).toMatchObject({ ok: false, reason: "local-only" });
  });
});

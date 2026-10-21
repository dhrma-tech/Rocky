// Phone access (roadmap A3, D-064): an allowed name works only over the HTTPS proxy, only with a
// paired device's cookie; pairing codes can't be guessed; phones can't touch secrets or delete.
import fs from "node:fs";
import {
  listDevices,
  memorySecrets,
  openRuntime,
  type Runtime,
  verifyDeviceToken,
} from "@rocky/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";

const PORT = 7337;
const TOKEN = "t".repeat(64);
const PHONE_HOST = "pc.tail1234.ts.net";
const PHONE = `https://${PHONE_HOST}`;

let dir: string;
let rt: Runtime;
let app: Hono;
let auth: Auth;
let now = 1_000;

beforeEach(async () => {
  dir = tempDir();
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  rt.config.daemon.allowedHosts = [PHONE_HOST];
  now = 1_000;
  auth = new Auth({
    token: TOKEN,
    port: PORT,
    now: () => now,
    allowedHosts: () => rt.config.daemon.allowedHosts,
    devices: { verify: (t) => verifyDeviceToken(rt.db, t) !== null },
  });
  app = createApp({ rt, auth });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const local = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`http://127.0.0.1:${PORT}${p}`, {
    ...init,
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

/** A request as `tailscale serve` forwards it: the phone's Host, X-Forwarded-Proto https. */
const phone = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`http://127.0.0.1:${PORT}${p}`, {
    ...init,
    headers: {
      host: PHONE_HOST,
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      ...init.headers,
    },
  });

async function pair(): Promise<string> {
  const { code } = (await (
    await local("/api/v1/devices/pair-code", { method: "POST" })
  ).json()) as {
    code: string;
  };
  const res = await phone("/auth/pair", {
    method: "POST",
    headers: { origin: PHONE },
    body: JSON.stringify({ code, name: "Dana's phone" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(";")[0] as string;
}

describe("phone access", () => {
  it("an allowed name needs the HTTPS proxy; any other name is refused", async () => {
    expect((await phone("/api/v1/health")).status).toBe(200);
    expect(
      (await phone("/api/v1/health", { headers: { "x-forwarded-proto": "http" } })).status,
    ).toBe(403);
    expect(
      (
        await app.request(`http://127.0.0.1:${PORT}/api/v1/health`, {
          headers: { host: PHONE_HOST },
        })
      ).status,
    ).toBe(403);
    expect((await phone("/api/v1/health", { headers: { host: "evil.ts.net" } })).status).toBe(403);
    rt.config.daemon.allowedHosts = [];
    expect((await phone("/api/v1/health")).status).toBe(403);
  });

  it("by an allowed name only a paired device's cookie works, never the token or a session", async () => {
    expect((await phone("/api/v1/settings")).status).toBe(401);
    expect(
      (await phone("/api/v1/settings", { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(401);
    const cookie = await pair();
    expect((await phone("/api/v1/settings", { headers: { cookie } })).status).toBe(200);
    // Writes still need the phone's own Origin.
    const put = (headers: Record<string, string>) =>
      phone("/api/v1/notifications/read-all", { method: "POST", headers: { cookie, ...headers } });
    expect((await put({})).status).toBe(403);
    expect((await put({ origin: "https://evil.example" })).status).toBe(403);
    expect((await put({ origin: PHONE })).status).toBe(200);
  });

  it("a revoked device is locked out at once", async () => {
    const cookie = await pair();
    const [device] = listDevices(rt.db);
    expect(device?.name).toBe("Dana's phone");
    expect((await local(`/api/v1/devices/${device?.id}/revoke`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await phone("/api/v1/settings", { headers: { cookie } })).status).toBe(401);
  });

  it("a pairing code dies after five wrong guesses, after 5 minutes, and after one use", async () => {
    const guess = (code: string) =>
      phone("/auth/pair", {
        method: "POST",
        headers: { origin: PHONE },
        body: JSON.stringify({ code, name: "x" }),
      });
    const first = auth.issuePairCode().code;
    const wrong = first === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await guess(wrong)).status).toBe(401);
    expect((await guess(first)).status).toBe(401);

    const late = auth.issuePairCode().code;
    now += 5 * 60_000 + 1;
    expect((await guess(late)).status).toBe(401);

    const once = auth.issuePairCode().code;
    expect((await guess(once)).status).toBe(200);
    expect((await guess(once)).status).toBe(401);
  });

  it("pairing without our Origin is refused", async () => {
    const { code } = auth.issuePairCode();
    const res = await phone("/auth/pair", {
      method: "POST",
      body: JSON.stringify({ code, name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("a phone can't write secrets, delete data, pair more devices, use MCP or bootstrap", async () => {
    const cookie = await pair();
    const h = { cookie, origin: PHONE };
    expect(
      (
        await phone("/api/v1/secrets/anthropic", {
          method: "POST",
          headers: h,
          body: '{"value":"x"}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await phone("/api/v1/deletion", {
          method: "POST",
          headers: h,
          body: JSON.stringify({ target: { everything: true }, confirm: "DELETE" }),
        })
      ).status,
    ).toBe(403);
    expect((await phone("/api/v1/devices/pair-code", { method: "POST", headers: h })).status).toBe(
      403,
    );
    expect(
      (await phone("/api/v1/devices/hosts", { method: "PUT", headers: h, body: '{"hosts":[]}' }))
        .status,
    ).toBe(403);
    expect((await phone("/api/v1/mcp", { method: "POST", headers: h, body: "{}" })).status).toBe(
      403,
    );
    const code = auth.issueCode();
    expect((await phone(`/auth/bootstrap?code=${code}`)).status).toBe(403);
  });

  it("allowed names are host names only, saved to rocky.yaml", async () => {
    const bad = await local("/api/v1/devices/hosts", {
      method: "PUT",
      body: JSON.stringify({ hosts: ["*.ts.net"] }),
    });
    expect(bad.status).toBe(400);
    expect(
      (await local("/api/v1/devices/hosts", { method: "PUT", body: '{"hosts":["192.168.1.5"]}' }))
        .status,
    ).toBe(400);
    const ok = await local("/api/v1/devices/hosts", {
      method: "PUT",
      body: JSON.stringify({ hosts: ["PC.Tail1234.ts.net", "pc.tail1234.ts.net"] }),
    });
    expect(await ok.json()).toEqual({ hosts: ["pc.tail1234.ts.net"] });
    expect(fs.readFileSync(`${dir}/rocky.yaml`, "utf8")).toContain("pc.tail1234.ts.net");
  });

  it("a pairing code needs an allowed name first, and the device list never shows a token", async () => {
    rt.config.daemon.allowedHosts = [];
    expect((await local("/api/v1/devices/pair-code", { method: "POST" })).status).toBe(409);
    rt.config.daemon.allowedHosts = [PHONE_HOST];
    await pair();
    const body = JSON.stringify(await (await local("/api/v1/devices")).json());
    expect(body).not.toMatch(/token/i);
  });
});

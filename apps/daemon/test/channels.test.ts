// Phone channels (D-065): the topic goes to the channel host and is never read back; a test send
// is refused in local-only mode and audited without its text.
import fs from "node:fs";
import {
  channelOnlySecrets,
  InProcessChannelHost,
  memorySecrets,
  openRuntime,
  type Runtime,
} from "@rocky/core";
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
let posted: string[];
const raw = memorySecrets();

beforeEach(async () => {
  dir = tempDir();
  posted = [];
  rt = await openRuntime({
    dataDir: dir,
    secrets: memorySecrets(),
    hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
  });
  for (const n of raw.list()) raw.delete(n as `${string}.${string}`);
  const channels = new InProcessChannelHost({
    secrets: channelOnlySecrets(raw),
    fetch: (async (url: string) => {
      posted.push(url);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
    config: () => rt.config,
  });
  app = createApp({ rt, auth: new Auth({ token: TOKEN, port: PORT }), channels });
});
afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (p: string, init: RequestInit = {}) =>
  app.request(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    ...init,
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
  });

describe("channel routes", () => {
  it("stores the topic write-only and reports only whether it is set", async () => {
    expect(await (await call("/channels")).json()).toEqual({
      ntfy: { topicSet: false, tokenSet: false },
      localOnly: false,
    });
    const bad = await call("/channels/ntfy/secret", {
      method: "POST",
      body: JSON.stringify({ name: "topic", value: "has spaces/and slash" }),
    });
    expect(bad.status).toBe(400);
    const ok = await call("/channels/ntfy/secret", {
      method: "POST",
      body: JSON.stringify({ name: "topic", value: "rocky_dana_7f3k" }),
    });
    expect(ok.status).toBe(200);
    const status = JSON.stringify(await (await call("/channels")).json());
    expect(status).toContain('"topicSet":true');
    expect(status).not.toContain("rocky_dana_7f3k");
    expect((await call("/channels/ntfy", { method: "DELETE" })).status).toBe(200);
    expect(raw.list()).toEqual([]);
  });

  it("a test send goes out when ntfy is on, is refused in local-only mode, and is audited", async () => {
    raw.set("channel.ntfy-topic", "rocky_dana_7f3k");
    expect((await call("/channels/test", { method: "POST" })).status).toBe(409); // switched off
    rt.config.notifications.ntfy.enabled = true;
    expect((await call("/channels/test", { method: "POST" })).status).toBe(200);
    expect(posted).toEqual(["https://ntfy.sh/rocky_dana_7f3k"]);
    rt.config.localOnly = true;
    const blocked = await call("/channels/test", { method: "POST" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("EGRESS_BLOCKED");
    expect(posted).toHaveLength(1);
    const rows = rt.db
      .prepare("select * from audit_log where event_type = 'notification_sent'")
      .all() as { meta: string }[];
    expect(rows.map((r) => JSON.parse(r.meta))).toEqual([{ channel: "ntfy", kind: "test" }]);
    expect(JSON.stringify(rows)).not.toContain("rocky_dana_7f3k");
  });
});

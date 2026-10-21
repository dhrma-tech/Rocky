// UI spec 16: /notifications lists what the notifier derived; read, snooze, dismiss; prefs in settings.
import fs from "node:fs";
import type { NotificationList } from "@rocky/contracts";
import { memorySecrets, Notifier, openRuntime, type Runtime, recordEvent } from "@rocky/core";
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

const headers = {
  host: `127.0.0.1:${PORT}`,
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};
const call = (path: string, init: RequestInit = {}) =>
  app.request(`http://127.0.0.1:${PORT}/api/v1${path}`, { ...init, headers });

describe("notification routes", () => {
  it("lists derived notifications and changes their state", async () => {
    const notifier = new Notifier({ db: rt.db });
    notifier.tick();
    recordEvent(rt.db, {
      kind: "approval",
      runId: "a1",
      actionId: "a1",
      change: "proposed",
      title: "Draft a reply",
      risk: "low",
      review: "standard",
    });
    notifier.tick();

    let list = (await (await call("/notifications")).json()) as NotificationList;
    expect(list.unread).toBe(1);
    const n = list.notifications[0];
    expect(n).toMatchObject({ kind: "needs_you", actionLabel: "Review" });
    if (!n) throw new Error("missing");

    expect(
      (await call("/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }))
        .status,
    ).toBe(200);
    list = (await (await call("/notifications")).json()) as NotificationList;
    expect(list.unread).toBe(0);

    await call("/notifications/snooze", {
      method: "POST",
      body: JSON.stringify({ ids: [n.id], until: Date.now() + 60_000 }),
    });
    list = (await (await call("/notifications")).json()) as NotificationList;
    expect(list.notifications).toHaveLength(0);
  });

  it("rejects bad bodies and queries", async () => {
    expect((await call("/notifications?tab=nope")).status).toBe(400);
    expect(
      (await call("/notifications/dismiss", { method: "POST", body: JSON.stringify({ ids: [] }) }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/notifications/snooze", {
          method: "POST",
          body: JSON.stringify({ ids: ["x"] }),
        })
      ).status,
    ).toBe(400);
  });

  it("saves notification preferences through settings", async () => {
    const prefs = {
      system: { needsYou: true, updates: true, headsUp: false },
      phone: { needsYou: false, updates: false, headsUp: false },
      quietHours: { enabled: true, start: "21:30", end: "06:45" },
    };
    const res = await call("/settings", {
      method: "PUT",
      body: JSON.stringify({ notifications: prefs }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notifications: unknown }).notifications).toEqual(prefs);
    expect(rt.config.notifications.quietHours.start).toBe("21:30");
    const bad = await call("/settings", {
      method: "PUT",
      body: JSON.stringify({
        notifications: { ...prefs, quietHours: { enabled: true, start: "25:00", end: "07:00" } },
      }),
    });
    expect(bad.status).toBe(400);
  });
});

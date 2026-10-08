// GET /events (SSE) and /events/page: replay after a cursor, then follow live.
import fs from "node:fs";
import type { EventsPage, RockyEvent } from "@rocky/contracts";
import { memorySecrets, openRuntime, type Runtime, recordEvent } from "@rocky/core";
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

const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };
const say = (text: string) =>
  recordEvent(rt.db, { kind: "message", runId: null, role: "user", text });

/** Reads SSE messages until `n` arrived, then disconnects. */
async function readSse(path: string, n: number, extra: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await app.request(`http://127.0.0.1:${PORT}/api/v1${path}`, {
    headers: { ...headers, ...extra },
    signal: ctrl.signal,
  });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: { id: string; event: string; data: RockyEvent }[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const field = (k: string) =>
        block
          .split("\n")
          .find((l) => l.startsWith(`${k}: `) || l.startsWith(`${k}:`))
          ?.replace(new RegExp(`^${k}: ?`), "");
      const data = field("data");
      if (data)
        out.push({ id: field("id") ?? "", event: field("event") ?? "", data: JSON.parse(data) });
      i = buf.indexOf("\n\n");
    }
  }
  ctrl.abort();
  await reader.cancel().catch(() => {});
  return out;
}

describe("events API", () => {
  it("pages events after a cursor", async () => {
    const a = say("one");
    const b = say("two");
    const res = await app.request(`http://127.0.0.1:${PORT}/api/v1/events/page?after=${a.seq}`, {
      headers,
    });
    const page = (await res.json()) as EventsPage;
    expect(page).toEqual({ events: [b], last: b.seq });
    const none = (await (
      await app.request(`http://127.0.0.1:${PORT}/api/v1/events/page?after=${b.seq}`, { headers })
    ).json()) as EventsPage;
    expect(none).toEqual({ events: [], last: b.seq });
    expect(
      (await app.request(`http://127.0.0.1:${PORT}/api/v1/events/page?after=-1`, { headers }))
        .status,
    ).toBe(400);
  });

  it("streams with id and event fields, replays after Last-Event-ID, then follows new events", async () => {
    const a = say("missed while offline");
    const b = say("also missed");
    // A reconnecting EventSource sends the last id it saw: only later events come back.
    const replay = readSse("/events", 2, { "last-event-id": String(a.seq) });
    setTimeout(() => say("live"), 100);
    const got = await replay;
    expect(got.map((m) => [m.id, m.event, m.data.kind === "message" ? m.data.text : ""])).toEqual([
      [String(b.seq), "message", "also missed"],
      [String(b.seq + 1), "message", "live"],
    ]);
  });

  it("needs the install token like every other API route", async () => {
    const res = await app.request(`http://127.0.0.1:${PORT}/api/v1/events`, {
      headers: { host: `127.0.0.1:${PORT}` },
    });
    expect(res.status).toBe(401);
  });
});

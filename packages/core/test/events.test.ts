// Typed event stream (UI spec "Agent UI"): one ordered, replayable log the UI renders from.
import fs from "node:fs";
import path from "node:path";
import type { Connector } from "@rocky/connector-sdk";
import { HttpError } from "@rocky/connector-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionRegistry,
  ConnectorRegistry,
  ConnectorService,
  type Db,
  eventsAfter,
  JobRunner,
  lastEventSeq,
  memorySecrets,
  recordEvent,
} from "../src/index.ts";
import { enqueue } from "../src/jobs/queue.ts";
import { openDb } from "../src/store/db.ts";
import { defaultMigrationsDir, migrate, readMigrations, rollback } from "../src/store/migrate.ts";
import { memoryDb, tempDir } from "./helpers.ts";
import { actionsWorld } from "./security/actions-helpers.ts";

const LATEST = readMigrations(defaultMigrationsDir).length;

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

const kinds = (d: Db, after = 0) => eventsAfter(d, after).map((e) => e.kind);

describe("event log", () => {
  it("assigns increasing seq numbers and replays strictly after a cursor", () => {
    const a = recordEvent(db, { kind: "message", runId: null, role: "user", text: "hi" });
    const b = recordEvent(db, {
      kind: "status",
      runId: "r1",
      state: "thinking",
      runKind: "ask",
      title: "Asking",
    });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(eventsAfter(db, 0)).toEqual([a, b]);
    expect(eventsAfter(db, a.seq)).toEqual([b]);
    expect(eventsAfter(db, 0, { runId: "r1" })).toEqual([b]);
    expect(lastEventSeq(db)).toBe(b.seq);
  });

  it("skips a stored row that no longer matches the schema instead of breaking the stream", () => {
    db.prepare(
      "insert into events (at, kind, run_id, payload) values (1, 'status', null, '{}')",
    ).run();
    recordEvent(db, { kind: "message", runId: null, role: "rocky", text: "ok" });
    expect(kinds(db)).toEqual(["message"]);
  });
});

describe("migrations from 006 on are reversible", () => {
  it("rolls back to 005 with a backup, and refuses to go below the first forward-only migration", () => {
    const dir = tempDir();
    const file = path.join(dir, "rocky.db");
    const backups = path.join(dir, "backups");
    const fileDb = openDb(file);
    try {
      migrate(fileDb, { backupDir: backups });
      expect(fileDb.pragma("user_version", { simple: true })).toBe(LATEST);
      recordEvent(fileDb, { kind: "message", runId: null, role: "user", text: "x" });
      // 005 has no down script: nothing changes.
      expect(() => rollback(fileDb, 4, { backupDir: backups })).toThrow(/no down script/);
      expect(fileDb.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(rollback(fileDb, 5, { backupDir: backups })).toEqual({ from: LATEST, to: 5 });
      expect(fileDb.pragma("user_version", { simple: true })).toBe(5);
      expect(
        fileDb.prepare("select name from sqlite_master where name = 'events'").get(),
      ).toBeUndefined();
      // The pre-rollback copy still has the event.
      const copies = fs.readdirSync(backups).filter((f) => f.startsWith(`rocky-${LATEST}-`));
      expect(copies).toHaveLength(1);
      // And forward again.
      migrate(fileDb, { backupDir: backups });
      expect(fileDb.pragma("user_version", { simple: true })).toBe(LATEST);
    } finally {
      fileDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emitters", () => {
  it("action transitions become approval events; execution adds a receipt", async () => {
    const w = actionsWorld();
    try {
      const a = w.propose("open a ticket");
      w.svc.approve(a.id, a.payloadHash);
      await w.svc.execute(a.id);
      const ev = eventsAfter(w.db, 0);
      expect(ev.map((e) => (e.kind === "approval" ? e.change : e.kind))).toEqual([
        "proposed",
        "approved",
        "executed",
        "receipt",
      ]);
      expect(ev[0]).toMatchObject({
        kind: "approval",
        actionId: a.id,
        runId: a.id,
        review: "standard",
      });
      expect(ev[3]).toMatchObject({
        kind: "receipt",
        count: 1,
        unit: "action",
        subject: { id: a.id },
      });
    } finally {
      w.db.close();
    }
  });

  it("a connector sync shows background work, then a receipt that says nothing changed in the app", async () => {
    let fail: Error | null = null;
    const fake: Connector<Record<string, never>, number> = {
      id: "fake",
      displayName: "Fake",
      permissions: "Reads",
      configSchema: z.object({}),
      secrets: [],
      defaultIntervalMin: 15,
      egress: () => [],
      async *sync() {
        if (fail) throw fail;
        yield {
          documents: [
            {
              externalId: "1",
              sourceType: "text",
              title: "One",
              createdAt: 1,
              updatedAt: 1,
              mime: "text/plain",
              body: { kind: "text", text: "hello" },
            },
          ],
          cursor: 1,
        };
      },
      async health() {
        return { status: "ok", message: "" };
      },
    };
    const registry = new ConnectorRegistry();
    registry.register(fake as Connector);
    const svc = new ConnectorService({
      db,
      registry,
      actions: new ActionRegistry(),
      blobsDir: tempDir(),
      secrets: memorySecrets(),
    });
    svc.add("fake", {});
    await svc.sync("fake");
    const ev = eventsAfter(db, 0);
    expect(ev.map((e) => (e.kind === "status" ? e.state : e.kind))).toEqual([
      "background",
      "receipt",
      "completed",
    ]);
    expect(ev[1]).toMatchObject({
      tool: "Fake",
      verb: "synced",
      count: 1,
      notDone: "0 changed in Fake",
    });

    fail = new HttpError(429, "https://x.example/", "slow down");
    db.prepare("update connector_state set next_sync_at = 0, backoff_until = null").run();
    const before = lastEventSeq(db);
    await svc.sync("fake");
    const failed = eventsAfter(db, before);
    expect(failed.map((e) => (e.kind === "status" ? e.state : e.kind))).toEqual([
      "background",
      "error",
      "failed",
    ]);
    expect(failed[1]).toMatchObject({
      code: "RATE_LIMITED",
      youCan: expect.stringMatching(/retry/),
    });
  });

  it("jobs report working then completed; a retry waits; embedding stays quiet", async () => {
    enqueue(db, "embed_document", { documentId: "d" });
    let calls = 0;
    const runner = new JobRunner(db, {
      embed_document: async () => {},
      study: async () => {
        calls++;
        if (calls === 1) throw new Error("model busy");
      },
    });
    enqueue(db, "study", { notebookId: "n" }, { maxAttempts: 2 });
    await runner.drain();
    // Retried jobs run after a backoff; make it due now and drain again.
    db.prepare("update jobs set run_after = 0").run();
    await runner.drain();
    const ev = eventsAfter(db, 0);
    expect(ev.map((e) => (e.kind === "status" ? `${e.title}:${e.state}` : e.kind))).toEqual([
      "Making study material:working",
      "error",
      "Making study material:waiting",
      "Making study material:working",
      "Making study material:completed",
    ]);
  });
});

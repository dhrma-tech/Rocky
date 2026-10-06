import {
  AuthExpired,
  type Connector,
  type DocumentBatch,
  type SourceDocument,
} from "@rocky/connector-sdk";
import type { Citation } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionRegistry,
  ActionService,
  ConnectorRegistry,
  ConnectorScheduler,
  ConnectorService,
  type Db,
  memorySecrets,
  type SecretStore,
} from "../src/index.ts";
import { memoryDb, tempDir } from "./helpers.ts";

let db: Db;
let secrets: SecretStore;
let registry: ConnectorRegistry;
let actions: ActionRegistry;
let svc: ConnectorService;
let clock: number;
let script: (cursor: number | undefined) => DocumentBatch<number>[] | Error;
let executed: { payload: unknown; token: string | null; key: string }[];

const doc = (n: number, text = `Issue ${n} body`): SourceDocument => ({
  externalId: `issue-${n}`,
  sourceType: "github",
  title: `Issue #${n}`,
  uri: `https://github.com/o/r/issues/${n}`,
  createdAt: 1,
  updatedAt: 2,
  mime: "text/markdown",
  body: {
    kind: "text",
    units: [
      { anchor: { kind: "github", type: "issue", number: n }, text },
      {
        anchor: { kind: "github", type: "comment", number: n, commentId: `c${n}` },
        heading: "Comment by octo",
        text: "We decided to ship it.",
      },
    ],
  },
});

const fake: Connector<{ repos: string[] }, number> = {
  id: "fakehub",
  displayName: "FakeHub",
  permissions: "Reads, creates issues",
  configSchema: z.object({
    repos: z.array(z.string()).min(1),
    backfillDays: z.number().optional(),
  }),
  secrets: [{ name: "token", label: "access token" }],
  defaultIntervalMin: 15,
  async *sync(_ctx, cursor) {
    const out = script(cursor);
    if (out instanceof Error) throw out;
    for (const b of out) {
      if (b.documents.some((d) => d.externalId === "boom"))
        throw new Error("network died mid-sync");
      yield b;
    }
  },
  async health(ctx) {
    return ctx.secrets.get("token") === "good"
      ? { status: "ok", message: "ok", account: "octo" }
      : { status: "auth_expired", message: "Bad credentials" };
  },
  actions: () => [
    {
      type: "fakehub.issueCreate",
      title: "Create issue",
      schema: z.object({ title: z.string() }),
      risk: "medium",
      describe: (p) => ({ target: "o/r", summary: p.title }),
      async execute(p, ctx) {
        executed.push({ payload: p, token: ctx.secrets.get("token"), key: ctx.idempotencyKey });
        return { number: 7 };
      },
    },
  ],
};

const other: Connector<Record<string, never>, string> = {
  id: "othernote",
  displayName: "Other",
  permissions: "Reads",
  configSchema: z.object({}),
  secrets: [{ name: "token", label: "token" }],
  defaultIntervalMin: 30,
  async *sync() {},
  async health() {
    return { status: "ok", message: "" };
  },
};

beforeEach(() => {
  db = memoryDb();
  secrets = memorySecrets();
  registry = new ConnectorRegistry();
  registry.register(fake);
  registry.register(other);
  actions = new ActionRegistry();
  clock = Date.UTC(2026, 9, 6, 9, 0);
  executed = [];
  svc = new ConnectorService({
    db,
    secrets,
    registry,
    actions,
    blobsDir: tempDir(),
    now: () => clock,
  });
});
afterEach(() => db.close());

const ready = () => {
  svc.add("fakehub", { repos: ["o/r"] });
  svc.setSecret("fakehub", "token", "good");
};

describe("ConnectorService setup", () => {
  it("validates config, rejects duplicates, and needs its secret before it is connected", () => {
    expect(() => svc.add("fakehub", { repos: [] })).toThrow(/repos/);
    expect(() => svc.add("nope")).toThrow(/Unknown connector/);
    svc.add("fakehub", { repos: ["o/r"] });
    expect(() => svc.add("fakehub", { repos: ["o/r"] })).toThrow(/already added/);
    expect(svc.get("fakehub")).toMatchObject({
      status: "not_configured",
      message: "Add the access token.",
    });
    svc.setSecret("fakehub", "token", "good");
    expect(svc.get("fakehub").status).toBe("connected");
    expect(() => svc.setSecret("fakehub", "password", "x")).toThrow(/no secret "password"/);
  });

  it("scopes secrets per connector and keeps them out of the catalog", () => {
    svc.setSecret("othernote", "token", "notion-secret");
    ready();
    expect(svc.scopedSecrets("fakehub").get("token")).toBe("good");
    expect(secrets.list().sort()).toEqual(["fakehub.token", "othernote.token"]);
    const cat = svc.catalog().find((c) => c.kind === "fakehub");
    expect(cat?.secrets).toEqual([{ name: "token", label: "access token", stored: true }]);
    expect(JSON.stringify(svc.catalog())).not.toContain("good");
  });

  it("health test reports bad credentials as needing reconnect", async () => {
    svc.add("fakehub", { repos: ["o/r"] });
    svc.setSecret("fakehub", "token", "revoked");
    expect(await svc.test("fakehub")).toMatchObject({ status: "auth_expired" });
    expect(svc.get("fakehub").status).toBe("needs_reconnect");
  });
});

describe("sync", () => {
  it("persists documents with their anchors, queues embedding, and stores the cursor and a run", async () => {
    ready();
    script = () => [{ documents: [doc(1), doc(2)], cursor: 2 }];
    await svc.sync("fakehub");
    const docs = db
      .prepare("select external_id, source_type, uri from documents order by external_id")
      .all();
    expect(docs).toEqual([
      { external_id: "issue-1", source_type: "github", uri: "https://github.com/o/r/issues/1" },
      { external_id: "issue-2", source_type: "github", uri: "https://github.com/o/r/issues/2" },
    ]);
    const anchors = (db.prepare("select anchor from chunks").all() as { anchor: string }[]).map(
      (r) => JSON.parse(r.anchor),
    );
    expect(anchors).toContainEqual({ kind: "github", type: "comment", number: 1, commentId: "c1" });
    expect(db.prepare("select count(*) n from jobs where type = 'embed_document'").get()).toEqual({
      n: 2,
    });
    const c = svc.get("fakehub");
    expect(c).toMatchObject({
      cursor: 2,
      status: "connected",
      lastRun: { status: "ok", added: 2 },
      documentCount: 2,
    });
    expect(c.nextSyncAt).toBe(clock + 15 * 60_000);
  });

  it("applies deltas and tombstones on the next sync", async () => {
    ready();
    script = () => [{ documents: [doc(1), doc(2)], cursor: 2 }];
    await svc.sync("fakehub");
    script = (cursor) => {
      expect(cursor).toBe(2);
      return [{ documents: [doc(2, "edited body")], deletedExternalIds: ["issue-1"], cursor: 3 }];
    };
    await svc.sync("fakehub");
    expect(svc.runs("fakehub")[0]).toMatchObject({ added: 0, updated: 1, deleted: 1 });
    expect(db.prepare("select external_id from documents").all()).toEqual([
      { external_id: "issue-2" },
    ]);
  });

  it("keeps the last committed cursor when a sync dies mid-way, then backs off", async () => {
    ready();
    script = () => [
      { documents: [doc(1)], cursor: 1 },
      { documents: [{ ...doc(9), externalId: "boom" }], cursor: 2 },
    ];
    await svc.sync("fakehub");
    const c = svc.get("fakehub");
    expect(c.cursor).toBe(1);
    expect(c).toMatchObject({
      status: "error",
      lastError: "network died mid-sync",
      documentCount: 1,
    });
    expect(c.lastRun).toMatchObject({ status: "error", added: 1 });
    expect(c.nextSyncAt).toBe(clock + 60_000);
    expect(svc.due()).toEqual([]);
    clock += 61_000;
    expect(svc.due()).toEqual(["fakehub"]);
  });

  it("marks an expired sign-in as needing reconnect and stops scheduling it", async () => {
    ready();
    script = () => new AuthExpired("token revoked");
    await svc.sync("fakehub");
    expect(svc.get("fakehub")).toMatchObject({
      status: "needs_reconnect",
      message: "token revoked",
    });
    clock += 24 * 3600_000;
    expect(svc.due()).toEqual([]);
  });

  it("runs one sync per connector: concurrent calls share it, another process's lock is respected", async () => {
    ready();
    let calls = 0;
    script = () => {
      calls++;
      return [{ documents: [doc(1)], cursor: 1 }];
    };
    await Promise.all([svc.sync("fakehub"), svc.sync("fakehub")]);
    expect(calls).toBe(1);
    db.prepare("update connector_state set lock_until = ?").run(clock + 60_000);
    await svc.sync("fakehub");
    expect(calls).toBe(1);
  });

  it("scheduler: one catch-up sync after a long gap, nothing for connectors not set up", async () => {
    ready();
    svc.add("othernote", {});
    let calls = 0;
    script = () => {
      calls++;
      return [{ documents: [], cursor: 1 }];
    };
    const sched = new ConnectorScheduler(svc);
    expect(sched.tick()).toEqual(["fakehub"]);
    await svc.idle();
    clock += 10 * 3600_000; // laptop slept through 40 intervals
    expect(sched.tick()).toEqual(["fakehub"]);
    await svc.idle();
    expect(sched.tick()).toEqual([]);
    expect(calls).toBe(2);
  });

  it("disconnect with purge removes its documents and its secrets", async () => {
    ready();
    script = () => [{ documents: [doc(1)], cursor: 1 }];
    await svc.sync("fakehub");
    expect(svc.remove("fakehub", { purge: true })).toEqual({ purged: 1 });
    expect(db.prepare("select count(*) n from documents").get()).toEqual({ n: 0 });
    expect(secrets.list()).toEqual([]);
    expect(svc.list()).toEqual([]);
  });
});

describe("connector actions", () => {
  const cite = (): Citation => {
    const d = db
      .prepare("select d.id, c.id as chunk from documents d join chunks c on c.document_id = d.id")
      .get() as {
      id: string;
      chunk: string;
    };
    return {
      chunkId: d.chunk,
      documentId: d.id,
      title: "Issue #1",
      anchor: { kind: "text" },
      quote: "ship it",
    };
  };

  it("run only through ActionService, with http and the connector's own secrets", async () => {
    ready();
    script = () => [{ documents: [doc(1)], cursor: 1 }];
    await svc.sync("fakehub");
    const service = new ActionService(db, actions);
    const a = service.propose({
      type: "fakehub.issueCreate",
      payload: { title: "Ship it" },
      origin: "user_turn",
      citations: [cite()],
    });
    expect(executed).toEqual([]);
    service.approve(a.id, a.payloadHash);
    expect((await service.execute(a.id)).status).toBe("executed");
    expect(executed).toEqual([
      { payload: { title: "Ship it" }, token: "good", key: a.idempotencyKey },
    ]);

    // Read-only connectors refuse at execute time.
    db.prepare("update connectors set read_only = 1").run();
    const b = service.propose({
      type: "fakehub.issueCreate",
      payload: { title: "Again" },
      origin: "user_turn",
      citations: [cite()],
    });
    service.approve(b.id, b.payloadHash);
    expect(await service.execute(b.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/read-only/),
    });
  });
});

describe("full sweep", () => {
  it("deletes documents missing from a sweep's presence list", async () => {
    ready();
    script = () => [{ documents: [doc(1), doc(2), doc(3)], cursor: 1 }];
    await svc.sync("fakehub");
    script = () => [{ documents: [], presentExternalIds: ["issue-1", "issue-3"], cursor: 2 }];
    await svc.sync("fakehub");
    expect(db.prepare("select external_id from documents order by external_id").all()).toEqual([
      { external_id: "issue-1" },
      { external_id: "issue-3" },
    ]);
    expect(svc.runs("fakehub")[0]).toMatchObject({ deleted: 1 });
  });
});

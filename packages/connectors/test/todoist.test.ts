import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { commandUuid, todoist } from "../src/todoist/index.ts";

// Hand-built from the API v1 reference (developer.todoist.com/api/v1, 2026-10-07); to be checked
// against a real account (Phase 7 live check).

const SYNC = "https://api.todoist.com/api/v1/sync";
const secrets = () => memorySecrets({ token: "todo-token" });

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  content: `Task ${id}`,
  description: "",
  project_id: "p1",
  due: null,
  checked: false,
  is_deleted: false,
  added_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  ...extra,
});

function exchange(list: Parameters<typeof replay>[0]) {
  const r = replay(list);
  const sent: Record<string, string>[] = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    sent.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
    return r.fetch(u, init);
  }) as typeof fetch;
  return { ...r, fetch: fetchFn, sent };
}

describe("Todoist sync", () => {
  it("full sync, then incremental with the sync token; deletions are tombstones", async () => {
    const x = exchange([
      {
        method: "POST",
        url: SYNC,
        body: {
          sync_token: "T1",
          full_sync: true,
          projects: [{ id: "p1", name: "School" }],
          items: [
            item("a", { due: { date: "2026-10-20", string: "Oct 20" }, description: "Pages 1-40" }),
            item("b"),
          ],
        },
      },
      {
        method: "POST",
        url: SYNC,
        body: {
          sync_token: "T2",
          full_sync: false,
          projects: [],
          items: [item("a", { checked: true }), item("b", { is_deleted: true })],
        },
      },
    ]);
    const first = await runSync(todoist, {
      fetch: x.fetch,
      config: { projects: [] },
      secrets: secrets(),
    });
    expect(x.sent[0]).toEqual({ sync_token: "*", resource_types: '["items","projects"]' });
    expect(
      first.documents.map((d) => [d.title, d.meta?.state, d.meta?.dueOn, d.meta?.project]),
    ).toEqual([
      ["Task a", "open", "2026-10-20", "School"],
      ["Task b", "open", undefined, "School"],
    ]);
    expect(first.cursor).toEqual({ syncToken: "T1", projects: { p1: "School" } });

    const next = await runSync(todoist, {
      fetch: x.fetch,
      config: { projects: [] },
      secrets: secrets(),
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(x.sent[1]?.sync_token).toBe("T1");
    expect(next.documents.map((d) => [d.externalId, d.meta?.state, d.meta?.project])).toEqual([
      ["a", "closed", "School"],
    ]);
    expect(next.deleted).toEqual(["b"]);
  });

  it("keeps only the configured projects", async () => {
    const x = exchange([
      {
        method: "POST",
        url: SYNC,
        body: {
          sync_token: "T1",
          full_sync: true,
          projects: [
            { id: "p1", name: "School" },
            { id: "p2", name: "Home" },
          ],
          items: [item("a"), item("c", { project_id: "p2" })],
        },
      },
    ]);
    const res = await runSync(todoist, {
      fetch: x.fetch,
      config: { projects: ["school"] },
      secrets: secrets(),
    });
    expect(res.documents.map((d) => d.externalId)).toEqual(["a"]);
    expect(res.deleted).toEqual(["c"]);
  });

  it("a rejected token asks for a new one", async () => {
    const x = exchange([{ method: "POST", url: SYNC, status: 401, body: {} }]);
    await expect(
      runSync(todoist, { fetch: x.fetch, config: { projects: [] }, secrets: secrets() }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });
});

describe("Todoist actions", () => {
  const [create, close] = todoist.actions?.() ?? [];
  if (!create || !close) throw new Error("actions missing");
  const ctx = (f: typeof fetch): ExecContext => ({
    idempotencyKey: "01KEY",
    signal: new AbortController().signal,
    config: { projects: [] },
    http: createHttp({ fetch: f, sleep: async () => {}, random: () => 0 }),
    secrets: secrets(),
  });

  it("adds a task with a command uuid from the idempotency key (Todoist runs it once)", async () => {
    const uuid = commandUuid("01KEY");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(commandUuid("01KEY")).toBe(uuid);
    const x = exchange([
      {
        method: "POST",
        url: SYNC,
        body: { sync_token: "x", full_sync: true, projects: [{ id: "p1", name: "School" }] },
      },
      {
        method: "POST",
        url: SYNC,
        body: {
          sync_token: "y",
          full_sync: false,
          sync_status: { [uuid]: "ok" },
          temp_id_mapping: { [`t-${uuid}`]: "task-9" },
        },
      },
    ]);
    const out = await create.execute(
      create.schema.parse({ content: "Read chapter 4", project: "school", due: "2026-10-20" }),
      ctx(x.fetch),
    );
    expect(out).toEqual({ taskId: "task-9", url: "https://app.todoist.com/app/task/task-9" });
    expect(JSON.parse(x.sent[1]?.commands ?? "[]")).toEqual([
      {
        type: "item_add",
        uuid,
        temp_id: `t-${uuid}`,
        args: { content: "Read chapter 4", project_id: "p1", due: { date: "2026-10-20" } },
      },
    ]);
  });

  it("reports a command Todoist refused, and closes tasks", async () => {
    const uuid = commandUuid("01KEY");
    const x = exchange([
      {
        method: "POST",
        url: SYNC,
        body: {
          sync_token: "y",
          full_sync: false,
          sync_status: { [uuid]: { error: "Item not found", error_code: 22 } },
        },
      },
    ]);
    await expect(close.execute(close.schema.parse({ id: "nope" }), ctx(x.fetch))).rejects.toThrow(
      /Item not found/,
    );
    const y = exchange([
      {
        method: "POST",
        url: SYNC,
        body: { sync_token: "z", full_sync: false, sync_status: { [uuid]: "ok" } },
      },
    ]);
    expect(await close.execute(close.schema.parse({ id: "task-9" }), ctx(y.fetch))).toEqual({
      taskId: "task-9",
      closed: true,
    });
    expect(JSON.parse(y.sent[0]?.commands ?? "[]")).toEqual([
      { type: "item_close", uuid, args: { id: "task-9" } },
    ]);
  });
});

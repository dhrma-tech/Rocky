import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { asana } from "../src/asana/index.ts";

// Hand-built from the Asana API reference (developers.asana.com, 2026-10-07); to be checked
// against a real account (Phase 7 live check).

const API = "https://app.asana.com/api/1.0";
const FIELDS =
  "name,notes,due_on,due_at,completed,assignee.name,permalink_url,created_at,modified_at,projects.name";
const secrets = () => memorySecrets({ token: "1/asana-pat" });
const config = { projects: ["1200001"] };
const since = Date.parse("2026-09-01T00:00:00.000Z");
const enc = encodeURIComponent;
const list = (q: string, modified: string, offset?: string) =>
  `${API}/tasks?${q}&modified_since=${enc(modified)}&opt_fields=${FIELDS}&limit=100${offset ? `&offset=${offset}` : ""}`;

const task = (gid: string, modified: string, extra: Record<string, unknown> = {}) => ({
  gid,
  name: `Task ${gid}`,
  notes: "",
  due_on: null,
  due_at: null,
  completed: false,
  assignee: { name: "Ana" },
  permalink_url: `https://app.asana.com/0/1200001/${gid}`,
  created_at: "2026-09-02T10:00:00.000Z",
  modified_at: modified,
  projects: [{ name: "Launch" }],
  ...extra,
});

describe("Asana sync", () => {
  it("pages per project, then asks only for tasks modified since the cursor", async () => {
    const r = replay([
      {
        url: list("project=1200001", "2026-09-01T00:00:00.000Z"),
        body: {
          data: [
            task("1", "2026-09-05T10:00:00.000Z", {
              due_on: "2026-10-20",
              notes: "Ship the checklist",
            }),
          ],
          next_page: { offset: "OFF2" },
        },
      },
      {
        url: list("project=1200001", "2026-09-01T00:00:00.000Z", "OFF2"),
        body: {
          data: [task("2", "2026-09-06T10:00:00.000Z", { completed: true })],
          next_page: null,
        },
      },
    ]);
    const res = await runSync(asana, { fetch: r.fetch, config, secrets: secrets(), since });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => [d.title, d.sourceType, d.meta?.state, d.meta?.dueOn])).toEqual(
      [
        ["Task 1", "task", "open", "2026-10-20"],
        ["Task 2", "task", "closed", undefined],
      ],
    );
    expect(res.batches.map((b) => b.cursor)).toEqual([
      {},
      { "project:1200001": "2026-09-06T10:00:00.000Z" },
    ]);

    const s = replay([
      {
        url: list("project=1200001", "2026-09-06T10:00:00.000Z"),
        body: { data: [], next_page: null },
      },
    ]);
    await runSync(asana, {
      fetch: s.fetch,
      config,
      secrets: secrets(),
      cursor: { "project:1200001": "2026-09-06T10:00:00.000Z" },
    });
    expect(s.unused()).toEqual([]);
  });

  it("can sync tasks assigned to me in a workspace; config needs a project or a workspace", async () => {
    const r = replay([
      {
        url: list("workspace=900&assignee=me", "2026-09-01T00:00:00.000Z"),
        body: { data: [], next_page: null },
      },
    ]);
    await runSync(asana, {
      fetch: r.fetch,
      config: { projects: [], workspace: "900" },
      secrets: secrets(),
      since,
    });
    expect(r.unused()).toEqual([]);
    expect(asana.configSchema.safeParse({ projects: [] }).success).toBe(false);
  });

  it("a rejected token asks for a new one", async () => {
    const r = replay([
      { url: list("project=1200001", "2026-09-01T00:00:00.000Z"), status: 401, body: {} },
    ]);
    await expect(
      runSync(asana, { fetch: r.fetch, config, secrets: secrets(), since }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Asana actions", () => {
  const [create, update] = asana.actions?.() ?? [];
  if (!create || !update) throw new Error("actions missing");
  const ctx = (f: typeof fetch): ExecContext => ({
    idempotencyKey: "01KEY",
    signal: new AbortController().signal,
    config,
    http: createHttp({ fetch: f, sleep: async () => {}, random: () => 0 }),
    secrets: secrets(),
  });
  /** Answers by path prefix, recording POST/PUT bodies. */
  function fake(recent: unknown[]) {
    const bodies: { method: string; url: string; body: unknown }[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      const method = init?.method ?? "GET";
      if (method !== "GET") bodies.push({ method, url, body: JSON.parse(String(init?.body)) });
      if (method === "GET") return Response.json({ data: recent });
      return Response.json({
        data: { gid: "777", permalink_url: "https://app.asana.com/0/1/777" },
      });
    }) as typeof fetch;
    return { f, bodies };
  }

  it("creates a task in the project, or returns the one made by a retry minutes ago", async () => {
    const a = fake([]);
    const p = create.schema.parse({ project: "1200001", name: "Send deck", due_on: "2026-10-20" });
    expect(await create.execute(p, ctx(a.f))).toEqual({
      gid: "777",
      url: "https://app.asana.com/0/1/777",
    });
    expect(a.bodies).toEqual([
      {
        method: "POST",
        url: `${API}/tasks?opt_fields=permalink_url`,
        body: {
          data: { name: "Send deck", notes: "", projects: ["1200001"], due_on: "2026-10-20" },
        },
      },
    ]);
    const b = fake([{ gid: "776", name: "Send deck", created_at: new Date().toISOString() }]);
    expect(await create.execute(p, ctx(b.f))).toMatchObject({ gid: "776", reused: true });
    expect(b.bodies).toEqual([]);
  });

  it("updates with PUT and refuses an empty update", async () => {
    const a = fake([]);
    await update.execute(update.schema.parse({ gid: "777", completed: true }), ctx(a.f));
    expect(a.bodies).toEqual([
      {
        method: "PUT",
        url: `${API}/tasks/777?opt_fields=permalink_url`,
        body: { data: { completed: true } },
      },
    ]);
    expect(update.schema.safeParse({ gid: "777" }).success).toBe(false);
  });
});

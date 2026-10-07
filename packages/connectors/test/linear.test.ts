import { createHttp, type ExecContext } from "@rocky/connector-sdk";
import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { linear, marker } from "../src/linear/index.ts";

// Hand-built from the documented GraphQL shapes (linear.app/developers, 2026-10-07); to be
// replaced by a scrubbed recording from a real workspace (Phase 7 live check).

const API = "https://api.linear.app/graphql";
const secrets = () => memorySecrets({ token: "lin_api_test" });
const config = { teamKeys: ["ENG"] };
const since = Date.parse("2026-09-01T00:00:00.000Z");

const issue = (n: number, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id: `uuid-${n}`,
  identifier: `ENG-${n}`,
  title: `Issue ${n}`,
  description: `Body ${n}`,
  url: `https://linear.app/acme/issue/ENG-${n}`,
  dueDate: null,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt,
  archivedAt: null,
  state: { name: "Todo", type: "unstarted" },
  team: { key: "ENG", name: "Engineering" },
  assignee: { name: "Ana", email: "ana@acme.io" },
  creator: { name: "Ravi", email: null },
  comments: { nodes: [] },
  ...extra,
});
const page = (nodes: unknown[], next: string | null = null) => ({
  data: { issues: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
});

/** Replay plus the GraphQL variables each request sent. */
function exchange(list: Parameters<typeof replay>[0]) {
  const r = replay(list);
  const sent: { query: string; variables: Record<string, unknown>; auth: string | null }[] = [];
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    sent.push({
      ...JSON.parse(String(init?.body ?? "{}")),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return r.fetch(u, init);
  }) as typeof fetch;
  return { ...r, fetch: fetchFn, sent };
}

describe("Linear sync", () => {
  it("pages through issues with comments; the cursor moves only after the last page", async () => {
    const x = exchange([
      {
        method: "POST",
        url: API,
        body: page(
          [
            issue(1, "2026-09-05T10:00:00.000Z", {
              dueDate: "2026-10-20",
              comments: {
                nodes: [
                  {
                    id: "c1",
                    body: "Repro on Safari 17.",
                    createdAt: "2026-09-05T09:00:00.000Z",
                    url: "https://linear.app/acme/issue/ENG-1#comment-c1",
                    user: { name: "Mei" },
                  },
                ],
              },
            }),
          ],
          "p2",
        ),
      },
      {
        method: "POST",
        url: API,
        body: page([
          issue(2, "2026-09-07T10:00:00.000Z", { state: { name: "Done", type: "completed" } }),
          issue(3, "2026-09-06T10:00:00.000Z", { archivedAt: "2026-09-06T10:00:00.000Z" }),
        ]),
      },
    ]);
    const res = await runSync(linear, { fetch: x.fetch, config, secrets: secrets(), since });
    expect(x.sent[0]?.auth).toBe("lin_api_test");
    expect(x.sent[0]?.variables).toEqual({
      first: 50,
      after: null,
      filter: { updatedAt: { gt: "2026-09-01T00:00:00.000Z" }, team: { key: { in: ["ENG"] } } },
    });
    expect(x.sent[1]?.variables.after).toBe("p2");
    expect(res.batches.map((b) => b.cursor)).toEqual([
      {},
      { updatedAt: "2026-09-07T10:00:00.000Z" },
    ]);
    expect(res.documents.map((d) => [d.title, d.sourceType, d.meta?.state])).toEqual([
      ["ENG-1: Issue 1", "task", "open"],
      ["ENG-2: Issue 2", "task", "closed"],
    ]);
    expect(res.deleted).toEqual(["uuid-3"]);
    const d1 = res.documents[0];
    expect(d1?.meta).toMatchObject({ dueOn: "2026-10-20", assignee: "Ana", project: "ENG" });
    if (d1?.body.kind !== "text") throw new Error("text body expected");
    expect(d1.body.units?.map((u) => [u.anchor, u.text])).toEqual([
      [{ kind: "row", rowId: "ENG-1" }, "Issue 1\n\nBody 1"],
      [{ kind: "row", rowId: "ENG-1#c1" }, "Repro on Safari 17."],
    ]);
  });

  it("an incremental sync asks only for issues updated after the cursor", async () => {
    const x = exchange([{ method: "POST", url: API, body: page([]) }]);
    await runSync(linear, {
      fetch: x.fetch,
      config: { teamKeys: [] },
      secrets: secrets(),
      cursor: { updatedAt: "2026-09-07T10:00:00.000Z" },
    });
    expect(x.sent[0]?.variables.filter).toEqual({ updatedAt: { gt: "2026-09-07T10:00:00.000Z" } });
  });

  it("an authentication error asks for a new key", async () => {
    const x = exchange([
      {
        method: "POST",
        url: API,
        status: 400,
        body: {
          errors: [
            { message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } },
          ],
        },
      },
    ]);
    await expect(
      runSync(linear, { fetch: x.fetch, config, secrets: secrets(), since }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });
});

describe("Linear actions", () => {
  const [create, update] = linear.actions?.() ?? [];
  if (!create || !update) throw new Error("actions missing");
  const ctx = (f: typeof fetch): ExecContext => ({
    idempotencyKey: "01KEY",
    signal: new AbortController().signal,
    config,
    http: createHttp({ fetch: f, sleep: async () => {}, random: () => 0 }),
    secrets: secrets(),
  });

  it("creates the issue with a hidden marker; a retry finds it instead", async () => {
    const x = exchange([
      { method: "POST", url: API, body: { data: { issues: { nodes: [] } } } },
      {
        method: "POST",
        url: API,
        body: { data: { teams: { nodes: [{ id: "team-1", key: "ENG" }] } } },
      },
      {
        method: "POST",
        url: API,
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" },
            },
          },
        },
      },
    ]);
    const p = create.schema.parse({
      teamKey: "ENG",
      title: "Fix Safari login",
      description: "From the standup",
      dueDate: "2026-10-20",
    });
    expect(await create.execute(p, ctx(x.fetch))).toEqual({
      identifier: "ENG-9",
      url: "https://linear.app/acme/issue/ENG-9",
    });
    expect(x.sent[0]?.variables).toEqual({ m: marker("01KEY") });
    expect(x.sent[2]?.variables).toEqual({
      input: {
        teamId: "team-1",
        title: "Fix Safari login",
        description: `From the standup\n\n${marker("01KEY")}`,
        dueDate: "2026-10-20",
      },
    });

    const y = exchange([
      {
        method: "POST",
        url: API,
        body: {
          data: {
            issues: {
              nodes: [{ identifier: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" }],
            },
          },
        },
      },
    ]);
    expect(await create.execute(p, ctx(y.fetch))).toMatchObject({
      identifier: "ENG-9",
      reused: true,
    });
    expect(y.sent).toHaveLength(1);
  });

  it("updates by state name and refuses an empty update", async () => {
    const x = exchange([
      {
        method: "POST",
        url: API,
        body: {
          data: { issue: { team: { states: { nodes: [{ id: "s-done", name: "Done" }] } } } },
        },
      },
      {
        method: "POST",
        url: API,
        body: {
          data: { issueUpdate: { success: true, issue: { identifier: "ENG-9", url: "u" } } },
        },
      },
    ]);
    await update.execute(update.schema.parse({ id: "ENG-9", state: "done" }), ctx(x.fetch));
    expect(x.sent[1]?.variables).toEqual({ id: "ENG-9", input: { stateId: "s-done" } });
    expect(update.schema.safeParse({ id: "ENG-9" }).success).toBe(false);
  });

  it("health names the user and workspace", async () => {
    const x = exchange([
      {
        method: "POST",
        url: API,
        body: { data: { viewer: { name: "Ana" }, organization: { name: "Acme" } } },
      },
    ]);
    expect(
      await linear.health({ config, http: createHttp({ fetch: x.fetch }), secrets: secrets() }),
    ).toMatchObject({ status: "ok", account: "Ana" });
  });
});

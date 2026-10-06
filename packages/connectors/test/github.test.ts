import { createHttp } from "@rocky/connector-sdk";
import { expectIncremental, memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { describe, expect, it } from "vitest";
import { github, marker } from "../src/github/index.ts";

// Hand-built from the documented response shapes (docs.github.com, API 2026-03-10); to be
// replaced by scrubbed recordings from a real account (Phase 4 acceptance #1).
const API = "https://api.github.com";
const H = (extra: Record<string, string> = {}) => ({ "x-ratelimit-remaining": "4999", ...extra });
const user = (login: string) => ({ login });
const issue = (n: number, updated: string, extra: Record<string, unknown> = {}) => ({
  id: 1000 + n,
  number: n,
  title: `Issue ${n}`,
  body: `Body of ${n}`,
  state: "open",
  html_url: `https://github.com/o/r/issues/${n}`,
  user: user("octo"),
  labels: [{ name: "bug" }],
  comments: 0,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: updated,
  ...extra,
});
const config = { repos: ["o/r"] };
const secrets = () => memorySecrets({ token: "github_pat_x" });
const since = Date.parse("2026-07-01T00:00:00Z");
const listUrl = (s: string, page?: number) =>
  `${API}/repos/o/r/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(s)}${page ? `&page=${page}` : ""}`;

describe("GitHub connector", () => {
  it("backfills issues and PRs with comments as anchored units, following Link pagination", async () => {
    const r = replay([
      {
        url: listUrl("2026-07-01T00:00:00.000Z"),
        headers: H({ link: `<${listUrl("2026-07-01T00:00:00.000Z", 2)}>; rel="next"` }),
        body: [issue(1, "2026-09-02T10:00:00Z", { comments: 1 }), issue(2, "2026-09-03T10:00:00Z")],
      },
      {
        url: `${API}/repos/o/r/issues/1/comments?per_page=100`,
        headers: H(),
        body: [
          {
            id: 555,
            body: "We decided to drop the free tier.",
            user: user("ana"),
            html_url: "https://github.com/o/r/issues/1#issuecomment-555",
            created_at: "2026-09-02T09:00:00Z",
          },
        ],
      },
      {
        url: listUrl("2026-07-01T00:00:00.000Z", 2),
        headers: H(),
        body: [
          issue(3, "2026-09-04T10:00:00Z", { pull_request: { url: "x" }, title: "Add export" }),
        ],
      },
    ]);
    const res = await runSync(github, { fetch: r.fetch, config, secrets: secrets(), since });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => d.externalId)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    expect(res.cursor).toEqual({ "o/r": "2026-09-04T10:00:00Z" });
    const d1 = res.documents[0];
    expect(d1?.uri).toBe("https://github.com/o/r/issues/1");
    if (d1?.body.kind !== "text") throw new Error("text body expected");
    expect(d1.body.units?.map((u) => u.anchor)).toEqual([
      { kind: "github", type: "issue", number: 1 },
      { kind: "github", type: "comment", number: 1, commentId: "555" },
    ]);
    expect(d1.body.units?.[1]?.text).toBe("We decided to drop the free tier.");
    const d3 = res.documents[2];
    expect(d3?.body.kind === "text" && d3.body.units?.[0]?.anchor).toEqual({
      kind: "github",
      type: "pr",
      number: 3,
    });
    expect(r.calls).toHaveLength(3);
  });

  it("a second sync asks only for items updated since the cursor (acceptance #2)", async () => {
    const r = replay([
      {
        url: listUrl("2026-09-04T10:00:00Z"),
        headers: H(),
        body: [issue(2, "2026-09-05T08:00:00Z", { body: "edited" })],
      },
    ]);
    const res = await runSync(github, {
      fetch: r.fetch,
      config,
      secrets: secrets(),
      cursor: { "o/r": "2026-09-04T10:00:00Z" },
    });
    expectIncremental(res, { maxRequests: 1, changedIds: ["o/r#2"] });
    expect(res.cursor).toEqual({ "o/r": "2026-09-05T08:00:00Z" });
  });

  it("reports a revoked token as auth expired, and a missing token before any request", async () => {
    const r = replay([
      {
        url: listUrl("2026-07-01T00:00:00.000Z"),
        status: 401,
        body: { message: "Bad credentials" },
      },
    ]);
    await expect(
      runSync(github, { fetch: r.fetch, config, secrets: secrets(), since }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const none = replay([]);
    await expect(
      runSync(github, { fetch: none.fetch, config, secrets: memorySecrets(), since }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(none.calls).toEqual([]);
  });

  it("health warns two weeks before the token expires and flags repos it can't see", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    const r = replay([
      {
        url: `${API}/user`,
        headers: { "github-authentication-token-expiration": `${soon} UTC` },
        body: user("octo"),
      },
      { url: `${API}/repos/o/r`, body: {} },
    ]);
    const h = await github.health({
      config,
      http: createHttp({ fetch: r.fetch }),
      secrets: secrets(),
    });
    expect(h).toMatchObject({
      status: "degraded",
      account: "octo",
      message: expect.stringMatching(/expires on/),
    });
    const r2 = replay([
      { url: `${API}/user`, body: user("octo") },
      { url: `${API}/repos/o/r`, status: 404, body: { message: "Not Found" } },
    ]);
    const h2 = await github.health({
      config,
      http: createHttp({ fetch: r2.fetch }),
      secrets: secrets(),
    });
    expect(h2).toMatchObject({
      status: "degraded",
      message: "No access to o/r. Add them to the token.",
    });
  });
});

describe("github.issueCreate", () => {
  const action = github.actions?.()[0];
  if (!action) throw new Error("action missing");
  const ctx = (fetchFn: typeof fetch, key = "01KEY") => ({
    idempotencyKey: key,
    signal: new AbortController().signal,
    config,
    http: createHttp({ fetch: fetchFn }),
    secrets: secrets(),
  });
  const recent = `${API}/repos/o/r/issues?state=all&sort=created&direction=desc&per_page=50`;

  it("creates the issue with a hidden idempotency marker", async () => {
    const r = replay([
      { url: recent, body: [issue(9, "2026-10-01T00:00:00Z")] },
      {
        method: "POST",
        url: `${API}/repos/o/r/issues`,
        status: 201,
        body: issue(10, "2026-10-06T00:00:00Z"),
      },
    ]);
    const posted: string[] = [];
    const spy = (async (u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(String(init.body));
      return r.fetch(u, init);
    }) as typeof fetch;
    const out = await action.execute(
      action.schema.parse({ repo: "o/r", title: "Ship beta", body: "From Rocky" }),
      ctx(spy),
    );
    expect(out).toEqual({ number: 10, url: "https://github.com/o/r/issues/10" });
    expect(JSON.parse(posted[0] as string)).toEqual({
      title: "Ship beta",
      body: `From Rocky\n\n${marker("01KEY")}`,
    });
  });

  it("returns the existing issue on retry instead of creating a duplicate", async () => {
    const r = replay([
      {
        url: recent,
        body: [issue(10, "2026-10-06T00:00:00Z", { body: `From Rocky\n\n${marker("01KEY")}` })],
      },
    ]);
    const out = await action.execute(
      action.schema.parse({ repo: "o/r", title: "Ship beta" }),
      ctx(r.fetch),
    );
    expect(out).toEqual({ number: 10, url: "https://github.com/o/r/issues/10", reused: true });
    expect(r.calls).toHaveLength(1);
  });

  it("refuses repositories that are not configured", async () => {
    const r = replay([]);
    await expect(
      action.execute(action.schema.parse({ repo: "evil/repo", title: "x" }), ctx(r.fetch)),
    ).rejects.toThrow(/not one of the repositories/);
    expect(r.calls).toEqual([]);
  });
});

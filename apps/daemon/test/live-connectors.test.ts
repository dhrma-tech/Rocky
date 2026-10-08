// Roadmap A2: the nightly live checks skip without credentials and report pass/fail per connector.
import { describe, expect, it } from "vitest";
import { LIVE_CHECKS, runLiveChecks } from "../scripts/live-connectors.ts";

const PAT = "github_pat_live_test";
const issue = {
  id: 1,
  number: 7,
  title: "Live check",
  body: "",
  state: "open",
  html_url: "https://github.com/o/r/issues/7",
  user: { login: "octo" },
  labels: [],
  comments: 0,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
};

const fakeGithub = (seen: string[]) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push(url.host);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${PAT}`)
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ login: "octo" });
    if (url.pathname === "/repos/o/r") return Response.json({ full_name: "o/r" });
    if (url.pathname === "/repos/o/r/issues")
      return Response.json(url.searchParams.get("sort") === "created" ? [] : [issue]);
    return Response.json([]);
  }) as typeof fetch;

describe("nightly live connector checks", () => {
  it("covers the roadmap's five candidates", () => {
    expect(LIVE_CHECKS.map((c) => c.id).sort()).toEqual([
      "gcal",
      "gdrive",
      "github",
      "gmail",
      "notion",
    ]);
  });

  it("skips every check when no credentials are set, without touching the network", async () => {
    const seen: string[] = [];
    const r = await runLiveChecks({}, { fetch: fakeGithub(seen) });
    expect(r.every((x) => x.outcome === "skip")).toBe(true);
    expect(r.find((x) => x.id === "github")?.detail).toBe(
      "not set: ROCKY_LIVE_GITHUB_TOKEN, ROCKY_LIVE_GITHUB_REPO",
    );
    expect(seen).toEqual([]);
  });

  it("passes with valid credentials and fails visibly with revoked ones, never printing the token", async () => {
    const github = LIVE_CHECKS.filter((c) => c.id === "github");
    const seen: string[] = [];
    const ok = await runLiveChecks(
      { ROCKY_LIVE_GITHUB_TOKEN: PAT, ROCKY_LIVE_GITHUB_REPO: "o/r" },
      { fetch: fakeGithub(seen), checks: github },
    );
    expect(ok[0]).toMatchObject({ id: "github", outcome: "pass" });
    expect(ok[0]?.detail).toMatch(/^health ok; first batch \d+ document\(s\)/);
    expect(new Set(seen)).toEqual(new Set(["api.github.com"]));

    const bad = await runLiveChecks(
      { ROCKY_LIVE_GITHUB_TOKEN: "github_pat_OLDVALUE9f8e7d", ROCKY_LIVE_GITHUB_REPO: "o/r" },
      { fetch: fakeGithub([]), checks: github },
    );
    expect(bad[0]?.outcome).toBe("fail");
    expect(bad[0]?.detail).toMatch(/rejected the token/);
    expect(JSON.stringify(bad)).not.toContain("OLDVALUE9f8e7d");
  });
});

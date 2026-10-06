import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AuthExpired,
  checkSdkRange,
  createHttp,
  loadPlugins,
  nextLink,
  refreshAccessToken,
  startLoopbackAuth,
} from "../src/index.ts";
import { replay } from "../src/testing.ts";

/** A fetch that returns the given responses in order and records each call. */
function scripted(responses: (() => Response)[]) {
  const calls: string[] = [];
  let i = 0;
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (!r) throw new Error("no response");
    return r();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

describe("createHttp (acceptance #5: 429s honor Retry-After)", () => {
  const harness = (responses: (() => Response)[], now = 1_000_000) => {
    const s = scripted(responses);
    const waits: number[] = [];
    const http = createHttp({
      fetch: s.fetch,
      sleep: async (ms) => void waits.push(ms),
      now: () => now,
      random: () => 0.5,
      baseDelayMs: 1000,
    });
    return { http, waits, calls: s.calls };
  };

  it("waits exactly Retry-After seconds, then succeeds", async () => {
    const h = harness([json(429, {}, { "retry-after": "7" }), json(200, { ok: 1 })]);
    expect(await h.http.json("https://api.example.com/x")).toEqual({ ok: 1 });
    expect(h.waits).toEqual([7000]);
    expect(h.http.requests).toBe(2);
  });

  it("reads Retry-After as an HTTP date", async () => {
    const now = Date.parse("2026-10-06T10:00:00Z");
    const h = harness(
      [json(503, {}, { "retry-after": "Tue, 06 Oct 2026 10:00:30 GMT" }), json(200, {})],
      now,
    );
    await h.http.json("https://api.example.com/x");
    expect(h.waits).toEqual([30_000]);
  });

  it("uses Notion's body retry_after and GitHub's spent-quota reset", async () => {
    const n = harness([json(429, { additional_data: { retry_after: 2 } }), json(200, {})]);
    await n.http.json("https://api.notion.com/v1/search");
    expect(n.waits).toEqual([2000]);
    const now = 1_700_000_000_000;
    const g = harness(
      [
        json(
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 42) },
        ),
        json(200, {}),
      ],
      now,
    );
    await g.http.json("https://api.github.com/repos/a/b/issues");
    expect(g.waits).toEqual([42_000]);
  });

  it("backs off with jitter when the server gives no delay, and stops after 5 attempts", async () => {
    const h = harness([json(500, { e: 1 })]);
    await expect(h.http.json("https://api.example.com/x")).rejects.toThrow(/HTTP 500/);
    expect(h.http.requests).toBe(5);
    expect(h.waits).toEqual([500, 1000, 2000, 4000]); // base·2^(n-1)·random(0.5)
  });

  it("does not retry ordinary client errors", async () => {
    const h = harness([json(404, { message: "Not Found" })]);
    await expect(h.http.json("https://api.example.com/x")).rejects.toThrow(/HTTP 404/);
    expect(h.http.requests).toBe(1);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const fetch = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response("{}");
    }) as typeof globalThis.fetch;
    const http = createHttp({ fetch, concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => http.json("https://x.test/")));
    expect(peak).toBe(2);
  });

  it("parses GitHub Link headers", () => {
    const res = new Response(null, {
      headers: {
        link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"',
      },
    });
    expect(nextLink(res)).toBe("https://api.github.com/x?page=2");
    expect(nextLink(new Response(null))).toBeNull();
  });
});

describe("OAuth loopback (Google, PKCE)", () => {
  it("exchanges the code with the PKCE verifier and rejects a forged state", async () => {
    const tokenCalls: URLSearchParams[] = [];
    const fakeToken = (async (_u: unknown, init?: RequestInit) => {
      tokenCalls.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as typeof globalThis.fetch;
    const s = await startLoopbackAuth({
      clientId: "cid",
      clientSecret: "csecret",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fetch: fakeToken,
    });
    const auth = new URL(s.authUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    const redirect = auth.searchParams.get("redirect_uri") as string;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const forged = await fetch(`${redirect}/?state=nope&code=x`);
    expect(forged.status).toBe(400);
    const ok = await fetch(`${redirect}/?state=${auth.searchParams.get("state")}&code=the-code`);
    expect(ok.status).toBe(200);
    expect(await s.done).toMatchObject({ refresh_token: "rt" });
    const sent = tokenCalls[0] as URLSearchParams;
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("client_secret")).toBe("csecret");
    // The verifier must hash to the challenge in the auth URL.
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(sent.get("code_verifier") as string)
        .digest("base64url"),
    ).toBe(auth.searchParams.get("code_challenge"));
  });

  it("maps invalid_grant to AuthExpired", async () => {
    const f = (async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof globalThis.fetch;
    await expect(
      refreshAccessToken({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        tokenUrl: "https://t.test",
        fetch: f,
      }),
    ).rejects.toBeInstanceOf(AuthExpired);
  });
});

describe("plugins", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rocky-plugin-"));

  it("checks the SDK major version", () => {
    expect(checkSdkRange({ rocky: { sdk: "^1" } })).toBeNull();
    expect(checkSdkRange({ rocky: { sdk: "^2.0.0" } })).toMatch(/needs connector SDK/);
    expect(checkSdkRange({})).toMatch(/no "rocky"/);
  });

  it("loads a file: plugin and reports a bad one without throwing", async () => {
    const good = tmp();
    fs.writeFileSync(
      path.join(good, "package.json"),
      JSON.stringify({ name: "p", main: "index.mjs", rocky: { sdk: "^1" } }),
    );
    fs.writeFileSync(
      path.join(good, "index.mjs"),
      "export default { id: 'demo', displayName: 'Demo', configSchema: { safeParse: () => ({ success: true }) }, async *sync() {}, async health() { return { status: 'ok', message: '' }; } };",
    );
    const bad = tmp();
    fs.writeFileSync(
      path.join(bad, "package.json"),
      JSON.stringify({ name: "q", main: "index.mjs", rocky: { sdk: "^1" } }),
    );
    fs.writeFileSync(path.join(bad, "index.mjs"), "export default { id: 'nope' };");
    const r = await loadPlugins([pathToFileURL(good).href, pathToFileURL(bad).href]);
    expect(r[0]?.connectors.map((c) => c.id)).toEqual(["demo"]);
    expect(r[1]?.error).toMatch(/default export must be a Connector/);
  });
});

describe("replay harness", () => {
  it("matches regardless of query order and rejects unexpected requests", async () => {
    const r = replay([{ url: "https://api.test/x?b=2&a=1", body: { ok: true } }]);
    expect(await (await r.fetch("https://api.test/x?a=1&b=2")).json()).toEqual({ ok: true });
    await expect(r.fetch("https://api.test/x?a=1&b=2")).rejects.toThrow(/Unexpected request/);
  });
});

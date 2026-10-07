import { memorySecrets, replay, runSync } from "@rocky/connector-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthog, renderResult } from "../src/posthog/index.ts";

// Hand-built from the PostHog API docs (posthog.com/docs/api, 2026-10-07); to be checked against
// a real project (Phase 7 live check).

const HOST = "https://eu.posthog.com";
const BASE = `${HOST}/api/projects/42/insights`;
const config = { host: HOST, projectId: 42, maxInsights: 2 };
const secrets = () => memorySecrets({ token: "phx_test" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T06:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("PostHog snapshots", () => {
  it("one dated snapshot per saved insight, capped, and nothing more that day", async () => {
    const r = replay([
      {
        url: `${BASE}/?saved=true&basic=true&limit=2`,
        body: {
          results: [
            { id: 1, short_id: "aB1", name: "Weekly signups" },
            { id: 2, short_id: "cD2", name: null, derived_name: "Checkout funnel" },
          ],
        },
      },
      {
        url: `${BASE}/1/?refresh=blocking`,
        body: {
          id: 1,
          short_id: "aB1",
          name: "Weekly signups",
          description: "New accounts per day",
          last_refresh: "2026-10-07T05:59:00Z",
          result: [
            {
              label: "signed up",
              count: 42,
              data: [5, 7, 30],
              days: ["2026-10-05", "2026-10-06", "2026-10-07"],
            },
          ],
        },
      },
      {
        url: `${BASE}/2/?refresh=blocking`,
        body: {
          id: 2,
          short_id: "cD2",
          name: null,
          derived_name: "Checkout funnel",
          result: [
            { name: "viewed cart", count: 100 },
            { name: "paid", count: 37.5 },
          ],
        },
      },
    ]);
    const res = await runSync(posthog, { fetch: r.fetch, config, secrets: secrets() });
    expect(r.unused()).toEqual([]);
    expect(res.documents.map((d) => [d.externalId, d.title, d.sourceType, d.uri])).toEqual([
      [
        "1:2026-10-07",
        "Weekly signups (2026-10-07)",
        "analytics",
        `${HOST}/project/42/insights/aB1`,
      ],
      [
        "2:2026-10-07",
        "Checkout funnel (2026-10-07)",
        "analytics",
        `${HOST}/project/42/insights/cD2`,
      ],
    ]);
    const body = res.documents[0]?.body;
    if (body?.kind !== "text") throw new Error("text body expected");
    expect(body.units?.[0]?.text).toBe(
      "New accounts per day\n\nSnapshot for 2026-10-07 (computed 2026-10-07T05:59:00Z):\nsigned up (total 42)\n2026-10-05: 5, 2026-10-06: 7, 2026-10-07: 30",
    );
    expect(res.cursor).toEqual({ day: "2026-10-07" });

    const again = replay([]);
    const res2 = await runSync(posthog, {
      fetch: again.fetch,
      config,
      secrets: secrets(),
      cursor: { day: "2026-10-07" },
    });
    expect(res2.documents).toEqual([]);
  });

  it("renders funnels, tables and unknown shapes", () => {
    expect(
      renderResult([
        { name: "a", count: 10 },
        { custom_name: "b", name: "x", count: 4 },
      ]),
    ).toBe("Step 1: a: 10\nStep 2: b: 4");
    expect(renderResult({ columns: ["day", "n"], results: [["2026-10-06", 3]] })).toBe(
      "day | n\n2026-10-06 | 3",
    );
    expect(renderResult({ weird: true })).toBe('{"weird":true}');
  });

  it("a key without access asks for a new one", async () => {
    const r = replay([
      { url: `${BASE}/?saved=true&basic=true&limit=2`, status: 403, body: { detail: "scope" } },
    ]);
    await expect(
      runSync(posthog, { fetch: r.fetch, config, secrets: secrets() }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { evaluateComputations, statedResults, substitute } from "../src/notebooks/math.ts";
import { NEW_CARD, nextEf, review } from "../src/notebooks/sm2.ts";

describe("SM-2 (acceptance #2)", () => {
  const run = (ratings: Parameters<typeof review>[1][]) => {
    let s: { ef: number; intervalDays: number; repetitions: number } = { ...NEW_CARD };
    const intervals: number[] = [];
    for (const r of ratings) {
      s = review(s, r, 0);
      intervals.push(s.intervalDays);
    }
    return { intervals, ef: s.ef, reps: s.repetitions };
  };

  it("follows the reference intervals 1, 6, 15, 38, 95 at quality 4 (EF stays 2.5)", () => {
    expect(run(["good", "good", "good", "good", "good"])).toEqual({
      intervals: [1, 6, 15, 38, 95],
      ef: 2.5,
      reps: 5,
    });
  });

  it("raises EF by 0.1 per easy answer and uses the new EF for the interval", () => {
    const r = run(["easy", "easy", "easy"]);
    expect(r.ef).toBeCloseTo(2.8);
    expect(r.intervals).toEqual([1, 6, Math.round(6 * 2.8)]);
  });

  it("lowers EF on hard answers, never below 1.3", () => {
    expect(nextEf(2.5, 3)).toBeCloseTo(2.36);
    let ef = 2.5;
    for (let i = 0; i < 20; i++) ef = nextEf(ef, 3);
    expect(ef).toBe(1.3);
  });

  it("a failure restarts repetitions at 1 day without changing EF (original SM-2)", () => {
    const s = review({ ef: 2.36, intervalDays: 15, repetitions: 3 }, "again", 0);
    expect(s).toEqual({ ef: 2.36, intervalDays: 1, repetitions: 0, dueAt: 86_400_000 });
  });
});

describe("math routing (acceptance #3)", () => {
  // Loading mathjs in the worker takes ~1 s idle and far longer when the full suite runs in
  // parallel; warm it here so the cold start never counts against a test timeout.
  beforeAll(() => evaluateComputations([{ id: "warm", expr: "1+1", purpose: "" }]), 60_000);

  it("evaluates percentages, units and derivatives in the sandbox", async () => {
    const r = await evaluateComputations([
      { id: "pct", expr: "17/100*2340", purpose: "17% of 2,340" },
      { id: "pct2", expr: "17% * 2340", purpose: "same with %" },
      { id: "unit", expr: "5 cm to inch", purpose: "convert" },
      { id: "d", expr: "derivative('x^2', 'x')", purpose: "slope" },
    ]);
    expect(r.map((x) => x.value)).toEqual(["397.8", "397.8", "1.96850393701 inch", "2 * x"]);
  });

  it("blocks import, createUnit and parser re-entry, and says when it can't compute", async () => {
    const r = await evaluateComputations([
      { id: "a", expr: "import({x: 1})", purpose: "" },
      { id: "b", expr: "createUnit('foo')", purpose: "" },
      { id: "c", expr: "evaluate('1+1')", purpose: "" },
      { id: "e", expr: "integrate(x^2, x)", purpose: "" },
      { id: "f", expr: "x".repeat(501), purpose: "" },
    ]);
    expect(r.map((x) => x.value)).toEqual([null, null, null, null, null]);
    expect(r[0]?.notComputed).toMatch(/disabled/);
    expect(r[3]?.notComputed).toMatch(/computer algebra/);
    expect(r[4]?.notComputed).toMatch(/too long/);
  });

  it("kills an expression that runs past 1 s", async () => {
    const t0 = Date.now();
    const [r] = await evaluateComputations([{ id: "slow", expr: "sum(1:30000000)", purpose: "" }]);
    expect(r?.notComputed).toMatch(/timed out|memory|Invalid array length/i);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("substitutes placeholders and catches numbers the model wrote itself", async () => {
    const results = await evaluateComputations([
      { id: "c1", expr: "17/100*2340", purpose: "17% of 2,340" },
    ]);
    expect(substitute("17% of 2,340 is {{calc:c1}}.", results)).toBe("17% of 2,340 is 397.8.");
    expect(substitute("{{calc:nope}}", results)).toBe("[not computed]");
    expect(statedResults("It is {{calc:c1}}.", results)).toEqual([]);
    expect(statedResults("It is 397.8, i.e. {{calc:c1}}.", results)).toEqual(["c1"]);
  });
});

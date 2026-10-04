// Spike 1: better-sqlite3 13 + sqlite-vec on this OS. KNN must match brute-force cosine.
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/index.ts";

const DIM = 768;
const N = 100;

function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32 - 0.5;
  };
}
const normalize = (v: Float32Array) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

describe("spike: sqlite-vec", () => {
  it("loads, creates vec0 and returns the same top-5 as brute force", () => {
    const db = openDb(":memory:");
    const { v } = db.prepare("select vec_version() as v").get() as { v: string };
    expect(v).toMatch(/^v0\.1\./);

    db.exec(
      `create virtual table vecs using vec0(id integer primary key, embedding float[${DIM}] distance_metric=cosine)`,
    );
    const r = rand(42);
    const vectors = Array.from({ length: N }, () =>
      normalize(Float32Array.from({ length: DIM }, r)),
    );
    const insert = db.prepare("insert into vecs(id, embedding) values (?, ?)");
    db.transaction(() => {
      for (const [i, vec] of vectors.entries()) insert.run(BigInt(i + 1), Buffer.from(vec.buffer));
    })();

    const q = normalize(Float32Array.from({ length: DIM }, r));
    const rows = db
      .prepare("select id from vecs where embedding match ? and k = 5 order by distance")
      .all(Buffer.from(q.buffer)) as { id: number }[];

    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
    const brute = vectors
      .map((vec, i) => ({ id: i + 1, score: dot(vec, q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.id);

    expect(rows.map((x) => Number(x.id))).toEqual(brute);
    db.close();
  });
});

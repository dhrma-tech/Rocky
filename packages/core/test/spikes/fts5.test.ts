// Spike 2: FTS5 is compiled into the bundled SQLite and ranks with bm25.
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/index.ts";

describe("spike: fts5", () => {
  it("matches and ranks by bm25", () => {
    const db = openDb(":memory:", { vec: false });
    db.exec("create virtual table docs using fts5(body, tokenize = 'porter unicode61')");
    const ins = db.prepare("insert into docs(rowid, body) values (?, ?)");
    ins.run(1, "The pricing decision was postponed to next week.");
    ins.run(2, "Pricing, pricing and more pricing: we decided on tiered pricing.");
    ins.run(3, "Lecture 4 covers eigenvalues.");
    const rows = db
      .prepare("select rowid from docs where docs match ? order by bm25(docs)")
      .all("pricing") as { rowid: number }[];
    expect(rows.map((r) => r.rowid)).toEqual([2, 1]);
    expect(db.prepare("select rowid from docs where docs match 'decide'").all()).toHaveLength(1);
    db.close();
  });
});

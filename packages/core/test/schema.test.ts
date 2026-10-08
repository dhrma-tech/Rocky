import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb } from "../src/index.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("migration 001", () => {
  it("creates the V1 tables", () => {
    const names = (
      db.prepare("select name from sqlite_master where type in ('table')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of [
      "documents",
      "chunks",
      "chunks_fts",
      "chunks_vec",
      "audit_log",
      "jobs",
      "usage_log",
      "conversations",
      "briefs",
      "events",
    ]) {
      expect(names).toContain(t);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(6);
  });

  it("makes audit_log append-only", () => {
    db.prepare(
      "insert into audit_log(at, event_type, actor, prev_hash, row_hash) values (1, 'x', 'system', '', 'h')",
    ).run();
    expect(() => db.prepare("update audit_log set event_type = 'y'").run()).toThrow(/append-only/);
    expect(() => db.prepare("delete from audit_log").run()).toThrow(/append-only/);
  });

  it("supports contentless FTS deletes and vec0 metadata filters", () => {
    db.prepare(
      "insert into chunks_fts(rowid, text, title) values (7, 'tiered pricing decision', 'Notes')",
    ).run();
    expect(
      db.prepare("select rowid from chunks_fts where chunks_fts match 'pricing'").all(),
    ).toHaveLength(1);
    db.prepare("delete from chunks_fts where rowid = 7").run();
    expect(
      db.prepare("select rowid from chunks_fts where chunks_fts match 'pricing'").all(),
    ).toHaveLength(0);

    const v = (x: number) => Buffer.from(new Float32Array(768).fill(x).buffer);
    const ins = db.prepare(
      "insert into chunks_vec(chunk_seq, embedding, source_type, created_at) values (?, ?, ?, ?)",
    );
    ins.run(1n, v(0.1), "pdf", 100n);
    ins.run(2n, v(0.2), "email", 200n);
    const rows = db
      .prepare(
        "select chunk_seq from chunks_vec where embedding match ? and k = 5 and source_type = 'email'",
      )
      .all(v(0.2)) as { chunk_seq: number }[];
    expect(rows.map((r) => Number(r.chunk_seq))).toEqual([2]);
  });

  it("cascades chunk deletes from documents", () => {
    db.prepare(
      "insert into documents(id, source_type, ingested_at, content_hash) values ('d1', 'txt', 1, 'h')",
    ).run();
    db.prepare(
      "insert into chunks(id, document_id, ord, text, token_count, char_start, char_end, anchor) values ('c1','d1',0,'t',1,0,1,'{}')",
    ).run();
    db.prepare("delete from documents where id = 'd1'").run();
    expect(db.prepare("select count(*) n from chunks").get()).toEqual({ n: 0 });
  });
});

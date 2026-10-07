// Phase 9 spike (SECURITY.md "Data at rest"): can Rocky's store run encrypted?
// better-sqlite3-multiple-ciphers is a drop-in better-sqlite3 build with SQLite3MultipleCiphers.
// Questions: does the full schema migrate, does sqlite-vec load and answer KNN, is the file
// unreadable without the key, and can an existing plain DB be converted?
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import { afterAll, describe, expect, it } from "vitest";
import { cipherDriver, type Db, migrate, openDb } from "../../src/index.ts";
import { tempDir } from "../helpers.ts";

// The same driver the store uses when encryption is on (an optional dependency).
const Database = cipherDriver();
const dir = tempDir("rocky-sqlcipher-");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MARKER = "PLAINTEXT-MARKER-the-capstone-demo-is-in-room-B12";

function openEncrypted(file: string, key: string) {
  const db = new Database(file);
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma(`key = "x'${key}'"`);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    sqliteVec.load(db);
    return db;
  } catch (err) {
    // A wrong key fails on the first read; close so Windows can delete the file.
    db.close();
    throw err;
  }
}

describe("spike: SQLCipher store", () => {
  const file = path.join(dir, "enc.db");

  it("migrates the full schema, stores text, and answers a sqlite-vec KNN query", () => {
    const db = openEncrypted(file, KEY);
    migrate(db as unknown as Db);
    expect((db.prepare("select vec_version() as v").get() as { v: string }).v).toMatch(/^v0\./);
    db.prepare(
      `insert into documents (id, source_type, title, ingested_at, raw_text, content_hash)
       values ('D1', 'text', 'Marker', 1, ?, 'h')`,
    ).run(MARKER);
    db.exec("create virtual table probe using vec0(embedding float[4])");
    const ins = db.prepare("insert into probe (rowid, embedding) values (?, ?)");
    ins.run(1n, new Float32Array([1, 0, 0, 0]));
    ins.run(2n, new Float32Array([0, 1, 0, 0]));
    const knn = db
      .prepare("select rowid from probe where embedding match ? order by distance limit 1")
      .get(new Float32Array([0.9, 0.1, 0, 0])) as { rowid: number };
    expect(Number(knn.rowid)).toBe(1);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  });

  it("leaves no plaintext on disk and refuses to open without the right key", () => {
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("enc.db")))
      expect(fs.readFileSync(path.join(dir, f)).includes(MARKER), f).toBe(false);
    const plain = new Database(file);
    expect(() => plain.prepare("select count(*) from documents").get()).toThrow(
      /not a database|encrypted/i,
    );
    plain.close();
    expect(() => {
      const wrong = openEncrypted(file, KEY.replace(/^0/, "f"));
      try {
        wrong.prepare("select count(*) from documents").get();
      } finally {
        wrong.close();
      }
    }).toThrow();
    const ok = openEncrypted(file, KEY);
    expect(ok.prepare("select raw_text from documents where id = 'D1'").get()).toEqual({
      raw_text: MARKER,
    });
    ok.close();
  });

  it("migration backups (VACUUM INTO) of an encrypted store stay encrypted", () => {
    const db = openEncrypted(file, KEY);
    const backup = path.join(dir, "backup.db");
    db.prepare("VACUUM INTO ?").run(backup);
    db.close();
    expect(fs.readFileSync(backup).includes(MARKER)).toBe(false);
    const b = openEncrypted(backup, KEY);
    expect(b.prepare("select count(*) as n from documents").get()).toEqual({ n: 1 });
    b.close();
  });

  it("encrypts an existing plain store in place with PRAGMA rekey (WAL off during the rekey)", () => {
    const plainFile = path.join(dir, "plain.db");
    const plain = openDb(plainFile);
    migrate(plain);
    plain
      .prepare(
        `insert into documents (id, source_type, title, ingested_at, raw_text, content_hash)
         values ('D2', 'text', 'Old', 1, ?, 'h')`,
      )
      .run(MARKER);
    plain.pragma("wal_checkpoint(TRUNCATE)");
    plain.close();

    const conv = new Database(plainFile);
    conv.pragma("journal_mode = DELETE");
    conv.pragma("cipher = 'sqlcipher'");
    conv.pragma(`rekey = "x'${KEY}'"`);
    conv.close();

    expect(fs.readFileSync(plainFile).includes(MARKER)).toBe(false);
    const enc = openEncrypted(plainFile, KEY);
    expect(enc.prepare("select title from documents where id = 'D2'").get()).toEqual({
      title: "Old",
    });
    enc.close();
  });
});

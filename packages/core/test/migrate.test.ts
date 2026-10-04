import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDb, readMigrations } from "../src/index.ts";

let tmp: string;
let migDir: string;
let db: Db | undefined;

const write = (name: string, sql: string) => fs.writeFileSync(path.join(migDir, name), sql);
const backups = () => fs.readdirSync(path.join(tmp, "backups")).sort();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-mig-"));
  migDir = path.join(tmp, "migrations");
  fs.mkdirSync(migDir);
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migrate", () => {
  it("applies migrations in order and is idempotent", () => {
    write("001_a.sql", "create table a(id integer primary key);");
    write("002_b.sql", "create table b(id integer primary key);");
    db = openDb(":memory:");
    expect(migrate(db, { dir: migDir })).toEqual({ from: 0, to: 2 });
    expect(migrate(db, { dir: migDir })).toEqual({ from: 2, to: 2 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("rolls back a failing migration, including the version bump", () => {
    write("001_a.sql", "create table a(id integer primary key);");
    write("002_bad.sql", "create table b(id integer primary key); insert into nope values (1);");
    db = openDb(":memory:");
    expect(() => migrate(db as Db, { dir: migDir })).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("select name from sqlite_master where name = 'b'").get()).toBeUndefined();
  });

  it("backs up an existing file DB before migrating and keeps the newest 3", () => {
    const file = path.join(tmp, "rocky.db");
    write("001_a.sql", "create table a(id integer primary key);");
    db = openDb(file);
    migrate(db, { dir: migDir });
    let ts = 1000;
    for (let v = 2; v <= 6; v++) {
      write(`00${v}_m.sql`, `create table t${v}(id integer primary key);`);
      migrate(db, { dir: migDir, backupDir: path.join(tmp, "backups"), now: () => ts++ });
    }
    expect(backups()).toEqual(["rocky-3-1002.db", "rocky-4-1003.db", "rocky-5-1004.db"]);
    const restored = openDb(path.join(tmp, "backups", "rocky-5-1004.db"), { readonly: true });
    expect(restored.pragma("user_version", { simple: true })).toBe(5);
    restored.close();
  });

  it("rejects gaps in numbering", () => {
    write("001_a.sql", "select 1;");
    write("003_c.sql", "select 1;");
    expect(() => readMigrations(migDir)).toThrow(/expected 2/);
  });
});

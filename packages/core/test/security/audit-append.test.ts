// SECURITY.md: "Audit log is append-only": append, triggers and chain links.
import { describe, expect, it } from "vitest";
import { appendAudit, canonical, GENESIS_HASH, rowHash } from "../../src/audit/append.ts";
import { memoryDb } from "../helpers.ts";

interface Row {
  seq: number;
  at: number;
  event_type: string;
  actor: string;
  subject_type: string | null;
  subject_id: string | null;
  payload_hash: string | null;
  meta: string;
  prev_hash: string;
  row_hash: string;
}

describe("audit append", () => {
  it("chains rows and rejects UPDATE and DELETE", () => {
    const db = memoryDb();
    appendAudit(db, { eventType: "a", actor: "system", meta: { n: 1 }, at: 1 });
    appendAudit(db, { eventType: "b", actor: "user", payload: { x: 1 }, at: 2 });
    const rows = db.prepare("select * from audit_log order by seq").all() as Row[];
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
    for (const r of rows) expect(rowHash(r)).toBe(r.row_hash);
    expect(() => db.prepare("update audit_log set meta = '{}' where seq = 1").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("delete from audit_log where seq = 2").run()).toThrow(/append-only/);
    expect(db.prepare("select count(*) n from audit_payloads").get()).toEqual({ n: 1 });
    db.close();
  });

  it("hashes canonical JSON independent of key order", () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

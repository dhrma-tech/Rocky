import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appendAudit } from "../../src/audit/append.ts";
import { verifyAuditChain } from "../../src/audit/verify.ts";
import { BudgetExceeded } from "../../src/router/errors.ts";
import { memoryDb } from "../helpers.ts";
import { fakeProviders, harness } from "../router-helpers.ts";

// Acceptance (e): tampering with an audit row breaks `audit verify`.

function seeded() {
  const db = memoryDb();
  for (let i = 1; i <= 5; i++)
    appendAudit(db, {
      eventType: "action_proposed",
      actor: "user",
      subjectType: "action",
      subjectId: `a${i}`,
      payload: { n: i },
      at: i,
    });
  // Tests stand in for an attacker with raw DB access: the append-only triggers go first.
  const unlock = () => {
    db.exec("drop trigger audit_log_no_update; drop trigger audit_log_no_delete;");
  };
  return { db, unlock };
}

describe("audit verify", () => {
  it("accepts an intact chain, including an empty one", () => {
    expect(verifyAuditChain(memoryDb())).toEqual({ ok: true, checked: 0 });
    expect(verifyAuditChain(seeded().db)).toEqual({ ok: true, checked: 5 });
  });

  it("reports the first row whose contents were edited", () => {
    const { db, unlock } = seeded();
    unlock();
    db.prepare("update audit_log set meta = ? where seq = 3").run(JSON.stringify({ forged: true }));
    expect(verifyAuditChain(db)).toMatchObject({ ok: false, firstBrokenSeq: 3, checked: 2 });
  });

  it("reports a re-hashed row by its broken link to the next row", () => {
    const { db, unlock } = seeded();
    unlock();
    db.prepare("update audit_log set row_hash = ? where seq = 2").run("a".repeat(64));
    // Row 2 no longer recomputes; even if the attacker fixed that, row 3's prev_hash breaks.
    expect(verifyAuditChain(db)).toMatchObject({ ok: false, firstBrokenSeq: 2 });
  });

  it("reports a deleted row", () => {
    const { db, unlock } = seeded();
    unlock();
    db.prepare("delete from audit_log where seq = 4").run();
    expect(verifyAuditChain(db)).toMatchObject({
      ok: false,
      firstBrokenSeq: 5,
      reason: expect.stringMatching(/prev_hash/),
    });
  });

  it("stays valid after payload bodies are purged (chain covers only hashes)", () => {
    const { db } = seeded();
    db.prepare("delete from audit_payloads").run();
    expect(verifyAuditChain(db)).toEqual({ ok: true, checked: 5 });
  });

  it("the triggers still block tampering when present", () => {
    const { db } = seeded();
    expect(() => db.prepare("update audit_log set meta = '{}' where seq = 1").run()).toThrow();
    expect(() => db.prepare("delete from audit_log where seq = 1").run()).toThrow();
  });

  it("budget blocks are audited", async () => {
    const db = memoryDb();
    const { fetch } = fakeProviders(() => ({ answer: "x" }));
    const h = harness(db, fetch);
    h.settings.monthlyCapUsd = 0.000001;
    await expect(
      h.router.run({
        task: "chat",
        origin: "user_turn",
        system: "s",
        prompt: "q",
        schema: z.object({ answer: z.string() }),
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    const types = (
      db.prepare("select event_type from audit_log").all() as { event_type: string }[]
    ).map((r) => r.event_type);
    expect(types).toContain("budget_blocked");
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});

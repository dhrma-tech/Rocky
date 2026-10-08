// Roadmap A4 + X4 and docs/DECISIONS.md D-014: rules and time-bound grants never weaken the
// approval invariants. Allow needs constraints and an end date; ask beats allow, block beats both;
// sends, deletes, strict-review proposals and foreign origins are always asked; every
// rule-approved action is bound to its payload hash and audited; approvals wait 10 s for Undo.
import type { Citation, RuleCreate } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionRegistry } from "../../src/actions/registry.ts";
import { ActionScheduler } from "../../src/actions/scheduler.ts";
import { ActionService, APPROVAL_HOLD_MS } from "../../src/actions/service.ts";
import { eventsAfter } from "../../src/events/log.ts";
import { upsertDocument } from "../../src/ingest/upsert.ts";
import { memoryDb } from "../helpers.ts";
import { auditTypes, seedCitation } from "./actions-helpers.ts";

const DAY = 86_400_000;

function world() {
  const db = memoryDb();
  const registry = new ActionRegistry();
  const sent: unknown[] = [];
  registry.register({
    type: "test.issue",
    title: "Create issue",
    connectorId: "tracker",
    schema: z.object({ repo: z.string(), title: z.string(), estimate: z.number().optional() }),
    risk: "medium",
    describe: (p) => ({ target: p.repo, summary: p.title }),
    execute: async (p) => {
      sent.push(p);
      return { ok: true };
    },
  });
  registry.register({
    type: "test.invite",
    title: "Create event",
    connectorId: "calendar",
    schema: z.object({ title: z.string(), attendees: z.array(z.string()) }),
    risk: "medium",
    actionClass: (p) => (p.attendees.length ? "send" : "write"),
    describe: (p) => ({ target: "calendar", summary: p.title }),
    execute: async (p) => {
      sent.push(p);
      return { ok: true };
    },
  });
  registry.register({
    type: "test.draft",
    title: "Create draft",
    connectorId: "mail",
    schema: z.object({ to: z.array(z.string()), subject: z.string() }),
    risk: "low",
    describe: (p) => ({ target: p.to.join(", "), summary: p.subject }),
    execute: async (p) => {
      sent.push(p);
      return { ok: true };
    },
  });
  let t = Date.UTC(2026, 9, 8, 9, 0);
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const svc = new ActionService(db, registry, { now: clock.now });
  const cite = seedCitation(db);
  const propose = (
    type: string,
    payload: unknown,
    citations: Citation[] = [cite],
    origin = "user_turn",
  ) => svc.propose({ type, payload, origin, citations });
  const rule = (r: RuleCreate) => svc.rules.create(r);
  const allowIssues = (extra: Partial<RuleCreate> = {}) =>
    rule({
      effect: "allow",
      connectorId: null,
      actionType: "test.issue",
      actionClass: null,
      constraints: [{ field: "repo", op: "equals", value: "o/r" }],
      expiresAt: clock.now() + 7 * DAY,
      ...extra,
    });
  return { db, svc, sent, clock, propose, rule, allowIssues, cite };
}

describe("allow rules", () => {
  it("approve a matching proposal by its payload hash, audit the rule, and hold it 10 s for Undo", async () => {
    const w = world();
    const r = w.allowIssues();
    const a = w.propose("test.issue", { repo: "o/r", title: "Fix login" });
    expect(a).toMatchObject({
      status: "approved",
      approvedBy: { kind: "rule", ruleId: r.id },
      executeAfter: w.clock.now() + APPROVAL_HOLD_MS,
    });
    const audit = w.db
      .prepare(
        "select actor, payload_hash, meta from audit_log where event_type = 'action_approved'",
      )
      .get() as { actor: string; payload_hash: string | null; meta: string };
    expect(audit.actor).toBe("system");
    expect(JSON.parse(audit.meta)).toMatchObject({ payloadHash: a.payloadHash, ruleId: r.id });
    expect(auditTypes(w.db)).toContain("rule_created");

    // Not before the hold ends.
    const scheduler = new ActionScheduler(w.svc);
    await scheduler.tick(w.clock.now());
    expect(w.sent).toEqual([]);
    await scheduler.tick(w.clock.now() + APPROVAL_HOLD_MS);
    expect(w.sent).toEqual([{ repo: "o/r", title: "Fix login" }]);
    expect(w.svc.get(a.id).status).toBe("executed");
    // Exactly once.
    await scheduler.tick(w.clock.now() + APPROVAL_HOLD_MS * 2);
    expect(w.sent).toHaveLength(1);
  });

  it("Undo during the hold returns it to a draft and nothing runs", async () => {
    const w = world();
    w.allowIssues();
    const a = w.propose("test.issue", { repo: "o/r", title: "Fix login" });
    expect(w.svc.revoke(a.id)).toMatchObject({
      status: "draft",
      approvedBy: null,
      executeAfter: null,
    });
    await new ActionScheduler(w.svc).tick(w.clock.now() + DAY);
    expect(w.sent).toEqual([]);
  });

  it("only match the constraints: another repo, or a missing field, is asked", () => {
    const w = world();
    w.allowIssues();
    expect(w.propose("test.issue", { repo: "o/other", title: "x" }).status).toBe("draft");
  });

  it("expire, and one-time grants are used once", () => {
    const w = world();
    w.allowIssues({ usesLeft: 1 });
    expect(w.propose("test.issue", { repo: "o/r", title: "1" }).status).toBe("approved");
    expect(w.propose("test.issue", { repo: "o/r", title: "2" }).status).toBe("draft");
    const later = world();
    later.allowIssues();
    later.clock.advance(8 * DAY);
    expect(later.propose("test.issue", { repo: "o/r", title: "late" }).status).toBe("draft");
  });

  it("stop applying once revoked", () => {
    const w = world();
    const r = w.allowIssues();
    w.svc.rules.revoke(r.id);
    expect(w.propose("test.issue", { repo: "o/r", title: "x" }).status).toBe("draft");
    expect(auditTypes(w.db)).toContain("rule_revoked");
    expect(w.svc.rules.get(r.id)?.active).toBe(false);
  });
});

describe("what a rule can never allow", () => {
  it("anything that sends: an invite with guests is asked even under a matching allow rule", () => {
    const w = world();
    w.rule({
      effect: "allow",
      connectorId: null,
      actionType: "test.invite",
      actionClass: null,
      constraints: [{ field: "title", op: "equals", value: "Standup" }],
      expiresAt: w.clock.now() + DAY,
    });
    expect(w.propose("test.invite", { title: "Standup", attendees: [] }).status).toBe("approved");
    const invite = w.propose("test.invite", { title: "Standup", attendees: ["a@x.org"] });
    expect(invite).toMatchObject({ status: "draft", actionClass: "send" });
  });

  it("a proposal drafted from external text (strict review)", () => {
    const w = world();
    w.allowIssues();
    const mail = upsertDocument(w.db, {
      parsed: {
        title: "Re: bug",
        sourceType: "email",
        text: "Please file it.",
        units: [{ anchor: { kind: "text" }, start: 0, end: 15, blocks: [] }],
      },
      externalId: "m",
      connectorId: "gmail",
    }).documentId;
    const a = w.propose("test.issue", { repo: "o/r", title: "x" }, [
      { ...w.cite, documentId: mail },
    ]);
    expect(a).toMatchObject({ status: "draft", review: "strict" });
  });

  it("refuses to save allow rules without a type, a condition or an end date, or for sends", () => {
    const w = world();
    const base: RuleCreate = {
      effect: "allow",
      connectorId: null,
      actionType: "test.issue",
      actionClass: null,
      constraints: [{ field: "repo", op: "equals", value: "o/r" }],
      expiresAt: w.clock.now() + DAY,
    };
    const problems = (r: Partial<RuleCreate>) => w.svc.rules.preview({ ...base, ...r }).problems;
    expect(problems({})).toEqual([]);
    expect(problems({ actionType: null })[0]).toMatch(/names one kind of action/);
    expect(problems({ constraints: [] })[0]).toMatch(/at least one condition/);
    expect(problems({ expiresAt: null })[0]).toMatch(/needs an end date/);
    expect(problems({ expiresAt: w.clock.now() - 1 })[0]).toMatch(/in the past/);
    expect(problems({ expiresAt: w.clock.now() + 91 * DAY })[0]).toMatch(/at most 90 days/);
    expect(problems({ actionClass: "delete" }).join(" ")).toMatch(
      /always asks before an action that deletes/,
    );
    expect(() => w.rule({ ...base, expiresAt: null })).toThrow(/end date/);
    expect(w.svc.rules.list()).toEqual([]);
  });
});

describe("ask and block", () => {
  it("ask first wins over a matching allow", () => {
    const w = world();
    w.allowIssues();
    w.rule({
      effect: "ask",
      connectorId: "tracker",
      actionType: null,
      actionClass: null,
      constraints: [],
    });
    expect(w.propose("test.issue", { repo: "o/r", title: "x" }).status).toBe("draft");
  });

  it("block records the proposal as rejected, names the rule, and never runs it", async () => {
    const w = world();
    const r = w.rule({
      effect: "block",
      connectorId: null,
      actionType: "test.draft",
      actionClass: null,
      constraints: [{ field: "to", op: "domainIn", value: ["evil.test"] }],
    });
    const a = w.propose("test.draft", { to: ["x@evil.test"], subject: "hi" });
    expect(a.status).toBe("rejected");
    const blocked = w.db
      .prepare("select meta from audit_log where event_type = 'action_blocked'")
      .get() as { meta: string };
    expect(JSON.parse(blocked.meta)).toEqual({ ruleId: r.id });
    expect(eventsAfter(w.db, 0).some((e) => e.kind === "approval" && e.change === "blocked")).toBe(
      true,
    );
    await new ActionScheduler(w.svc).tick(w.clock.now() + DAY);
    expect(w.sent).toEqual([]);
  });
});

describe("constraints", () => {
  it("domainIn needs every address at an allowed domain; oneOf and lte check values", () => {
    const w = world();
    w.rule({
      effect: "allow",
      connectorId: null,
      actionType: "test.draft",
      actionClass: null,
      constraints: [{ field: "to", op: "domainIn", value: ["acme.dev"] }],
      expiresAt: w.clock.now() + DAY,
    });
    expect(w.propose("test.draft", { to: ["a@acme.dev", "B@ACME.DEV"], subject: "s" }).status).toBe(
      "approved",
    );
    expect(w.propose("test.draft", { to: ["a@acme.dev", "x@other.io"], subject: "s" }).status).toBe(
      "draft",
    );
    expect(w.propose("test.draft", { to: [], subject: "s" }).status).toBe("draft");

    w.allowIssues({ constraints: [{ field: "estimate", op: "lte", value: 3 }] });
    expect(w.propose("test.issue", { repo: "a/b", title: "t", estimate: 2 }).status).toBe(
      "approved",
    );
    expect(w.propose("test.issue", { repo: "a/b", title: "t", estimate: 5 }).status).toBe("draft");
    expect(w.propose("test.issue", { repo: "a/b", title: "t" }).status).toBe("draft");
  });
});

describe("preview", () => {
  it("says in words what the rule does and how many past approvals it would have skipped", () => {
    const w = world();
    for (const title of ["a", "b"]) {
      const a = w.propose("test.issue", { repo: "o/r", title });
      w.svc.approve(a.id, a.payloadHash);
    }
    const other = w.propose("test.issue", { repo: "o/x", title: "c" });
    w.svc.approve(other.id, other.payloadHash);
    const p = w.svc.rules.preview({
      effect: "allow",
      connectorId: null,
      actionType: "test.issue",
      actionClass: null,
      constraints: [{ field: "repo", op: "equals", value: "o/r" }],
      expiresAt: Date.UTC(2026, 9, 15),
    });
    expect(p).toEqual({
      sentence:
        'Rocky will create issue when repo is "o/r" without asking, until 2026-10-15. It still records each one in the audit log.',
      wouldHaveSkipped: 2,
      problems: [],
    });
  });
});

describe("deny", () => {
  it("keeps an optional note for Rocky in the audit entry; nothing runs", async () => {
    const w = world();
    const a = w.propose("test.issue", { repo: "o/r", title: "x" });
    expect(w.svc.reject(a.id, "  Wrong repo, use o/web.  ").status).toBe("rejected");
    const row = w.db
      .prepare("select meta from audit_log where event_type = 'action_rejected'")
      .get() as { meta: string };
    expect(JSON.parse(row.meta)).toEqual({ note: "Wrong repo, use o/web." });
    await new ActionScheduler(w.svc).tick(w.clock.now() + DAY);
    expect(w.sent).toEqual([]);
  });
});

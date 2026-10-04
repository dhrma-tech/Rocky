import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/actions/types.ts";
import { actionsWorld, auditTypes } from "./actions-helpers.ts";

// Acceptance (a): every state transition is tested, legal and illegal (specs/actions.md).

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ActionError ? e.code : String(e);
  }
  return "no error";
};
const codeAsync = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    return e instanceof ActionError ? e.code : String(e);
  }
  return "no error";
};

describe("action state machine", () => {
  it("propose → draft, with hash, idempotency key, risk and an audit entry", () => {
    const w = actionsWorld();
    const a = w.propose("open a ticket");
    expect(a).toMatchObject({
      status: "draft",
      risk: "low",
      type: "test.echo",
      title: "Echo (test)",
    });
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.idempotencyKey).toMatch(/^[0-9A-Z]{26}$/);
    expect(a.description).toEqual({ target: "test", summary: "open a ticket" });
    expect(w.propose("high stakes").risk).toBe("high");
    expect(auditTypes(w.db)).toEqual(["action_proposed", "action_proposed"]);
  });

  it("draft → edit keeps draft and changes the hash", () => {
    const w = actionsWorld();
    const a = w.propose();
    const b = w.svc.edit(a.id, { message: "edited" });
    expect(b.status).toBe("draft");
    expect(b.payloadHash).not.toBe(a.payloadHash);
    expect(b.payload).toEqual({ message: "edited" });
  });

  it("draft → approved → executing → executed", async () => {
    const w = actionsWorld();
    const a = w.propose();
    expect(w.svc.approve(a.id, a.payloadHash).status).toBe("approved");
    const done = await w.svc.execute(a.id);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ echoed: "open a ticket" });
    expect(w.calls).toEqual([
      { payload: { message: "open a ticket" }, idempotencyKey: a.idempotencyKey },
    ]);
    expect(auditTypes(w.db)).toEqual(["action_proposed", "action_approved", "action_executed"]);
  });

  it("approved → executing → failed, never retried, clone makes a new draft", async () => {
    const w = actionsWorld();
    const a = w.svc.propose({
      type: "test.echo",
      payload: { message: "x", fail: true },
      origin: "user_turn",
      citations: [w.cite],
    });
    w.svc.approve(a.id, a.payloadHash);
    const f = await w.svc.execute(a.id);
    expect(f.status).toBe("failed");
    expect(f.error).toMatch(/on purpose/);
    expect(await codeAsync(() => w.svc.execute(a.id))).toBe("ILLEGAL_TRANSITION");
    expect(w.calls).toHaveLength(1);
    const c = w.svc.clone(a.id);
    expect(c.status).toBe("draft");
    expect(c.id).not.toBe(a.id);
    expect(c.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("draft → rejected; approved → revoke → draft", () => {
    const w = actionsWorld();
    expect(w.svc.reject(w.propose().id).status).toBe("rejected");
    const a = w.propose();
    w.svc.approve(a.id, a.payloadHash);
    const r = w.svc.revoke(a.id);
    expect(r).toMatchObject({ status: "draft", approvedAt: null });
  });

  it("refuses every illegal transition", async () => {
    const w = actionsWorld();
    const draft = w.propose();
    const approved = w.propose();
    w.svc.approve(approved.id, approved.payloadHash);
    const rejected = w.propose();
    w.svc.reject(rejected.id);
    const executed = w.propose();
    w.svc.approve(executed.id, executed.payloadHash);
    await w.svc.execute(executed.id);

    // execute: only from approved
    for (const id of [draft.id, rejected.id, executed.id])
      expect(await codeAsync(() => w.svc.execute(id))).toBe("ILLEGAL_TRANSITION");
    // approve: only from draft
    for (const a of [approved, rejected, executed])
      expect(code(() => w.svc.approve(a.id, a.payloadHash))).toBe("ILLEGAL_TRANSITION");
    // edit: only drafts
    for (const id of [approved.id, rejected.id, executed.id])
      expect(code(() => w.svc.edit(id, { message: "x" }))).toBe("ILLEGAL_TRANSITION");
    // reject: only drafts
    for (const id of [approved.id, rejected.id, executed.id])
      expect(code(() => w.svc.reject(id))).toBe("ILLEGAL_TRANSITION");
    // revoke: only approved
    for (const id of [draft.id, rejected.id, executed.id])
      expect(code(() => w.svc.revoke(id))).toBe("ILLEGAL_TRANSITION");
    // clone: only failed
    for (const id of [draft.id, approved.id, rejected.id, executed.id])
      expect(code(() => w.svc.clone(id))).toBe("ILLEGAL_TRANSITION");
    expect(code(() => w.svc.get("nope"))).toBe("NOT_FOUND");
  });

  it("concurrent execute runs the executor exactly once", async () => {
    const w = actionsWorld();
    const a = w.propose();
    w.svc.approve(a.id, a.payloadHash);
    const results = await Promise.allSettled([
      w.svc.execute(a.id),
      w.svc.execute(a.id),
      w.svc.execute(a.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
    expect(w.svc.get(a.id).status).toBe("executed");
  });

  it("validates payloads at propose and edit", () => {
    const w = actionsWorld();
    expect(
      code(() =>
        w.svc.propose({
          type: "test.echo",
          payload: { message: "" },
          origin: "user_turn",
          citations: [w.cite],
        }),
      ),
    ).toBe("INVALID_PAYLOAD");
    expect(code(() => w.svc.edit(w.propose().id, { nope: 1 }))).toBe("INVALID_PAYLOAD");
    expect(
      code(() =>
        w.svc.propose({ type: "x.unknown", payload: {}, origin: "user_turn", citations: [w.cite] }),
      ),
    ).toBe("UNKNOWN_TYPE");
  });
});

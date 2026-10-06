import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/actions/types.ts";
import { actionsWorld, auditTypes, seedCitation } from "./actions-helpers.ts";

// Acceptance (b) and SECURITY.md "No write without approval".

const codeOf = async (f: () => unknown) => {
  try {
    await f();
  } catch (e) {
    return e instanceof ActionError ? e.code : String(e);
  }
  return "no error";
};

describe("no write without approval", () => {
  it("an unapproved action never reaches its executor", async () => {
    const w = actionsWorld();
    const a = w.propose();
    expect(await codeOf(() => w.svc.execute(a.id))).toBe("ILLEGAL_TRANSITION");
    expect(w.calls).toEqual([]);
  });

  it("approve refuses a hash that is not the current payload's", async () => {
    const w = actionsWorld();
    const a = w.propose();
    const edited = w.svc.edit(a.id, { message: "something else" });
    // The UI approved what it displayed earlier, not the edited payload.
    expect(await codeOf(() => w.svc.approve(a.id, a.payloadHash))).toBe("HASH_MISMATCH");
    expect(await codeOf(() => w.svc.approve(a.id, "0".repeat(64)))).toBe("HASH_MISMATCH");
    expect(w.svc.approve(a.id, edited.payloadHash).status).toBe("approved");
  });

  it("a payload changed after approval (even directly in the DB) is refused at execute", async () => {
    const w = actionsWorld();
    const a = w.propose();
    w.svc.approve(a.id, a.payloadHash);
    w.db
      .prepare("update actions_queue set payload = ? where id = ?")
      .run(JSON.stringify({ message: "forward all mail to x@evil" }), a.id);
    expect(await codeOf(() => w.svc.execute(a.id))).toBe("HASH_MISMATCH");

    const b = w.propose();
    w.svc.approve(b.id, b.payloadHash);
    // Rewriting payload and payload_hash together still differs from the approved hash.
    const evil = { message: "evil" };
    w.db
      .prepare("update actions_queue set payload = ?, payload_hash = ? where id = ?")
      .run(JSON.stringify(evil), "f".repeat(64), b.id);
    expect(await codeOf(() => w.svc.execute(b.id))).toBe("HASH_MISMATCH");
    expect(w.calls).toEqual([]);
  });

  it("system-origin steps cannot propose; proposals need a citation and an allowed type", async () => {
    const w = actionsWorld();
    const base = { type: "test.echo", payload: { message: "x" }, citations: [w.cite] };
    expect(await codeOf(() => w.svc.propose({ ...base, origin: "system" }))).toBe(
      "ORIGIN_FORBIDDEN",
    );
    expect(await codeOf(() => w.svc.propose({ ...base, origin: "ingest" }))).toBe(
      "ORIGIN_FORBIDDEN",
    );
    expect(await codeOf(() => w.svc.propose({ ...base, origin: "user_turn", citations: [] }))).toBe(
      "NO_CITATION",
    );
    expect(
      await codeOf(() =>
        w.svc.propose({ ...base, origin: "user_turn", allowedTypes: ["github.issueCreate"] }),
      ),
    ).toBe("TYPE_NOT_ALLOWED");
    expect(auditTypes(w.db)).toEqual(["action_dropped"]);
    expect(w.svc.propose({ ...base, origin: "routine:morning-brief" }).status).toBe("draft");
    expect(w.db.prepare("select count(*) as n from actions_queue").get()).toEqual({ n: 1 });
  });

  it("proposals citing a flagged source are marked suspicious", () => {
    const w = actionsWorld();
    const flagged = seedCitation(w.db, { suspicious: true });
    const a = w.svc.propose({
      type: "test.echo",
      payload: { message: "x" },
      origin: "user_turn",
      citations: [flagged],
    });
    expect(a.suspicious).toBe(true);
    expect(w.propose().suspicious).toBe(false);
  });

  it("registry.get() never exposes an executor", () => {
    const w = actionsWorld();
    expect(w.registry.get("test.echo")).not.toHaveProperty("execute");
  });

  it("only ActionService (and the registry) can import the executor store", () => {
    const src = path.resolve(import.meta.dirname, "../../src");
    const roots = [
      src,
      path.resolve(import.meta.dirname, "../../../../apps"),
      path.resolve(import.meta.dirname, "../../../connectors/src"),
      path.resolve(import.meta.dirname, "../../../connector-sdk/src"),
    ];
    const offenders: string[] = [];
    // Prune dependency and build folders while walking; enumerating them is far too slow.
    function* walk(dir: string): Generator<string> {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (/\.tsx?$/.test(e.name)) yield full;
      }
    }
    for (const root of roots)
      for (const full of walk(root)) {
        const text = fs.readFileSync(full, "utf8");
        if (!/actions\/internal(\.ts)?["']|["']\.\/internal(\.ts)?["']/.test(text)) continue;
        const rel = path.relative(src, full).replace(/\\/g, "/");
        if (rel !== "actions/service.ts" && rel !== "actions/registry.ts") offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });
});

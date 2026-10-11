// Onboarding state, the Read only preset and the key test (UI spec 3, D-048).
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { echoAction } from "../src/actions/echo.ts";
import { ActionRegistry } from "../src/actions/registry.ts";
import { ActionService } from "../src/actions/service.ts";
import {
  describeKeyError,
  isFirstRun,
  loadOnboarding,
  READ_ONLY_NOTE,
  testApiKey,
  updateOnboarding,
} from "../src/onboarding/onboarding.ts";
import { EgressBlocked, MissingApiKey, ProviderFailure } from "../src/router/errors.ts";
import type { ProviderGate } from "../src/router/gate.ts";
import { loadPolicy } from "../src/router/policy.ts";
import type { Db } from "../src/store/db.ts";
import { memoryDb, tempDir } from "./helpers.ts";
import { HW_HIGH } from "./router-helpers.ts";

let dir: string;
let db: Db;
let actions: ActionService;

beforeEach(() => {
  dir = tempDir();
  db = memoryDb();
  const registry = new ActionRegistry();
  registry.register(echoAction().def);
  actions = new ActionService(db, registry);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("onboarding state", () => {
  it("starts at step 1 with defaults and resumes where it was left", () => {
    expect(loadOnboarding(dir)).toMatchObject({ step: 1, name: "Rocky", swatch: "periwinkle" });
    updateOnboarding(dir, db, actions.rules, { step: 3, name: "Pip", swatch: "sage" });
    expect(loadOnboarding(dir)).toMatchObject({ step: 3, name: "Pip", swatch: "sage" });
  });

  it("falls back to defaults when the file is damaged", () => {
    fs.writeFileSync(`${dir}/onboarding.json`, "{ not json");
    expect(loadOnboarding(dir).step).toBe(1);
  });

  it("is a first run only on an empty, unfinished install", () => {
    expect(isFirstRun(db, loadOnboarding(dir))).toBe(true);
    db.prepare(
      `insert into documents (id, connector_id, source_type, title, content_hash, ingested_at)
       values ('d1', 'local-files', 'markdown', 'x', 'h', 1)`,
    ).run();
    expect(isFirstRun(db, loadOnboarding(dir))).toBe(false);
  });

  it("is never a first run once finished, and records completion in the audit log", () => {
    const s = updateOnboarding(dir, db, actions.rules, { complete: true }, 1234);
    expect(s.completedAt).toBe(1234);
    expect(isFirstRun(db, s)).toBe(false);
    const row = db
      .prepare("select meta from audit_log where event_type = 'onboarding_completed'")
      .get() as { meta: string } | undefined;
    expect(row && JSON.parse(row.meta)).toEqual({ preset: "ask-everything" });
  });
});

describe("Read only preset", () => {
  it("adds one block rule on every action, and switching back revokes exactly it", () => {
    const s = updateOnboarding(dir, db, actions.rules, { preset: "read-only" });
    const rule = actions.rules.get(s.readOnlyRuleId ?? "");
    expect(rule).toMatchObject({
      effect: "block",
      connectorId: null,
      actionType: null,
      actionClass: null,
      note: READ_ONLY_NOTE,
      active: true,
    });
    // Choosing it again does not stack a second rule.
    updateOnboarding(dir, db, actions.rules, { preset: "read-only" });
    expect(actions.rules.list().filter((r) => r.active)).toHaveLength(1);

    const back = updateOnboarding(dir, db, actions.rules, { preset: "ask-everything" });
    expect(back.readOnlyRuleId).toBeNull();
    expect(actions.rules.get(rule?.id ?? "")?.active).toBe(false);
  });

  it("blocks a proposal while it is on", () => {
    updateOnboarding(dir, db, actions.rules, { preset: "read-only" });
    const facts = {
      connectorId: null,
      type: "echo",
      actionClass: "write" as const,
      payload: {},
      review: "standard" as const,
      origin: "user_turn",
    };
    expect(actions.rules.decide(facts)).toMatchObject({ effect: "block" });
  });

  it("switching back still works after the rule was revoked in Settings", () => {
    const s = updateOnboarding(dir, db, actions.rules, { preset: "read-only" });
    actions.rules.revoke(s.readOnlyRuleId ?? "");
    expect(updateOnboarding(dir, db, actions.rules, { preset: "ask-everything" }).preset).toBe(
      "ask-everything",
    );
  });
});

describe("Test connection", () => {
  const ctx = { hardware: HW_HIGH, localOnly: false };
  const gate = (call: () => Promise<unknown>) => ({ call }) as unknown as ProviderGate;

  it("reports success with the model it reached", async () => {
    const r = await testApiKey(
      gate(async () => ({})),
      loadPolicy(dir),
      ctx,
    );
    expect(r).toMatchObject({ ok: true, model: expect.stringContaining("claude") });
  });

  it("never resolves to a local model, and says so under local-only", async () => {
    const r = await testApiKey(
      gate(async () => {
        throw new Error("must not be called");
      }),
      loadPolicy(dir),
      { ...ctx, localOnly: true },
    );
    expect(r).toMatchObject({ ok: false, reason: "local-only" });
  });

  it.each([
    [new MissingApiKey("anthropic"), "no-key"],
    [new EgressBlocked("anthropic", "global setting"), "local-only"],
    [new ProviderFailure("provider_down", "anthropic is unreachable"), "host-unreachable"],
    [new ProviderFailure("timeout", "timed out"), "host-unreachable"],
    [new ProviderFailure("error", "anthropic error: invalid x-api-key"), "key-invalid"],
    [
      new ProviderFailure("error", "anthropic error: 404 not_found_error model: x"),
      "model-missing",
    ],
    [new Error("something else"), "other"],
  ])("names the cause: %s", (err, reason) => {
    expect(describeKeyError(err, "m").reason).toBe(reason);
  });
});

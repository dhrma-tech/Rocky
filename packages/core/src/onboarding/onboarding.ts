import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RuleStore } from "../actions/policy.ts";
import { appendAudit } from "../audit/append.ts";
import {
  BudgetExceeded,
  EgressBlocked,
  MissingApiKey,
  ProviderFailure,
  TaskNeedsApi,
  UnknownPrice,
} from "../router/errors.ts";
import type { ProviderGate } from "../router/gate.ts";
import { type PolicyFile, type ResolveContext, resolveChain } from "../router/policy.ts";
import type { Db } from "../store/db.ts";

/**
 * Onboarding (UI spec 3, D-048): four steps, saved after each so closing the tab resumes at the
 * same step. The state is a small JSON file in the data dir, not the store: it holds no user data,
 * only the name and colour the user gave Rocky and how far they got.
 */

export const SWATCHES = ["periwinkle", "rose", "sage", "butter", "lilac", "peach"] as const;
export const PRESETS = ["ask-everything", "read-only"] as const;
export type Preset = (typeof PRESETS)[number];

export const OnboardingStateSchema = z.object({
  step: z.number().int().min(1).max(4).default(1),
  name: z.string().trim().min(1).max(40).default("Rocky"),
  swatch: z.enum(SWATCHES).default("periwinkle"),
  preset: z.enum(PRESETS).default("ask-everything"),
  /** The block rule "Read only" made, so switching back revokes exactly that rule. */
  readOnlyRuleId: z.string().nullable().default(null),
  completedAt: z.number().int().nullable().default(null),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingPatchSchema = z
  .object({
    step: z.number().int().min(1).max(4),
    name: z.string().trim().min(1).max(40),
    swatch: z.enum(SWATCHES),
    preset: z.enum(PRESETS),
    complete: z.literal(true),
  })
  .partial()
  .strict();
export type OnboardingPatch = z.infer<typeof OnboardingPatchSchema>;

const file = (dataDir: string) => path.join(dataDir, "onboarding.json");

export function loadOnboarding(dataDir: string): OnboardingState {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dataDir), "utf8")) as unknown;
    const parsed = OnboardingStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: start over at step 1 (it holds no user data).
  }
  return OnboardingStateSchema.parse({});
}

function save(dataDir: string, s: OnboardingState): void {
  const tmp = `${file(dataDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, file(dataDir));
}

/**
 * First run: setup not finished and nothing in the store yet. An install that already has
 * documents or connectors (from before onboarding existed) is never sent through it.
 */
export function isFirstRun(db: Db, s: OnboardingState): boolean {
  if (s.completedAt !== null) return false;
  const has = (sql: string) => Boolean(db.prepare(sql).get());
  return !has("select 1 from documents limit 1") && !has("select 1 from connectors limit 1");
}

export const READ_ONLY_NOTE = "Read only (chosen during setup)";

export function updateOnboarding(
  dataDir: string,
  db: Db,
  rules: RuleStore,
  patch: OnboardingPatch,
  now = Date.now(),
): OnboardingState {
  const s = loadOnboarding(dataDir);
  if (patch.step !== undefined) s.step = patch.step;
  if (patch.name !== undefined) s.name = patch.name;
  if (patch.swatch !== undefined) s.swatch = patch.swatch;
  if (patch.preset !== undefined && patch.preset !== s.preset) {
    // Read only is one block rule on every action: Rocky still reads and answers, but no change
    // reaches an app. It shows in Settings > Rules like any other rule and can be revoked there.
    if (patch.preset === "read-only") {
      const rule = rules.create({
        effect: "block",
        connectorId: null,
        actionType: null,
        actionClass: null,
        constraints: [],
        note: READ_ONLY_NOTE,
      });
      s.readOnlyRuleId = rule.id;
    } else if (s.readOnlyRuleId) {
      // Already revoked in Settings is fine; a rule that no longer exists is too.
      if (rules.get(s.readOnlyRuleId)) rules.revoke(s.readOnlyRuleId);
      s.readOnlyRuleId = null;
    }
    s.preset = patch.preset;
  }
  if (patch.complete && s.completedAt === null) {
    s.completedAt = now;
    appendAudit(db, {
      eventType: "onboarding_completed",
      actor: "user",
      at: now,
      meta: { preset: s.preset },
    });
  }
  save(dataDir, s);
  return s;
}

// --- Step 2: "Test connection" for an API key ---

export type KeyTestResult =
  | { ok: true; model: string; ms: number }
  | {
      ok: false;
      reason:
        | "no-key"
        | "key-invalid"
        | "host-unreachable"
        | "model-missing"
        | "local-only"
        | "budget"
        | "other";
      message: string;
    };

/**
 * One tiny call (8 output tokens) through ProviderGate, so local-only and the budget cap apply
 * and the call is in the usage log like any other. The result names the cause in plain words.
 */
export async function testApiKey(
  gate: ProviderGate,
  policy: PolicyFile,
  ctx: ResolveContext,
  now: () => number = Date.now,
): Promise<KeyTestResult> {
  const started = now();
  let model = "";
  try {
    const target = resolveChain(policy, "key_test", ctx)[0];
    if (!target) throw new TaskNeedsApi("key_test");
    model = target.model;
    await gate.call(target, {
      task: "key_test",
      origin: "user_turn",
      system: "Reply with the single word: ok",
      prompt: "ok?",
      maxTokens: 8,
      timeoutMs: 20_000,
    });
    return { ok: true, model, ms: now() - started };
  } catch (err) {
    return describeKeyError(err, model);
  }
}

export function describeKeyError(err: unknown, model: string): KeyTestResult & { ok: false } {
  if (err instanceof MissingApiKey)
    return { ok: false, reason: "no-key", message: "No API key is saved yet." };
  if (err instanceof EgressBlocked || err instanceof TaskNeedsApi)
    return {
      ok: false,
      reason: "local-only",
      message: "Local-only mode is on, so Rocky won't call an online model.",
    };
  if (err instanceof BudgetExceeded || err instanceof UnknownPrice)
    return { ok: false, reason: "budget", message: (err as Error).message };
  const text = err instanceof Error ? err.message : String(err);
  if (err instanceof ProviderFailure && (err.kind === "provider_down" || err.kind === "timeout"))
    return {
      ok: false,
      reason: "host-unreachable",
      message: "Rocky couldn't reach the provider. Check the internet connection and try again.",
    };
  if (/401|403|authentication|invalid x-api-key|api key/i.test(text))
    return { ok: false, reason: "key-invalid", message: "The provider didn't accept that key." };
  if (/404|not_found|model/i.test(text))
    return {
      ok: false,
      reason: "model-missing",
      message: `The key works, but the model ${model || "in policies.yaml"} isn't available to it.`,
    };
  return { ok: false, reason: "other", message: text.slice(0, 300) };
}

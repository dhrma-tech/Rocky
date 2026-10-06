import type { Hardware, Task } from "@rocky/contracts";
import { z } from "zod";
import { deepMerge, loadLayeredYaml } from "../config/load.ts";
import { TaskNeedsApi } from "./errors.ts";

const TaskPolicySchema = z.object({
  primary: z.string(),
  fallback: z.string().optional(),
  exam_grade: z.string().optional(),
  escalate_on: z.array(z.string()).default([]),
  local_allowed: z.boolean().default(true),
  max_tokens: z.number().int().positive().optional(),
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;

export const PolicyFileSchema = z.object({
  tasks: z.record(z.string(), TaskPolicySchema),
  models: z.record(z.string(), z.string().regex(/^[a-z_]+\/.+$/, "models must be provider/model")),
  model_options: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Ollama models derived from a pulled base with a larger context (doctor --fix creates them). */
  ollama_models: z
    .record(z.string(), z.object({ from: z.string(), num_ctx: z.number().int().min(2048) }))
    .default({}),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export const LOCAL_PROVIDERS = new Set(["ollama", "whisper"]);

export interface Target {
  alias: string;
  provider: string;
  model: string;
  local: boolean;
  options: Record<string, unknown>;
}

export function loadPolicy(
  dataDir: string,
  notebookOverride?: Record<string, unknown>,
): PolicyFile {
  const merged = loadLayeredYaml("policies", dataDir);
  return PolicyFileSchema.parse(notebookOverride ? deepMerge(merged, notebookOverride) : merged);
}

/** `tier(local:medium if ram>=15 && gpu else api:strong)` → the alias the hardware allows. */
export function evalTier(expr: string, hw: Pick<Hardware, "ramGb" | "gpus" | "cuda">): string {
  const m = /^tier\(\s*(\S+)\s+if\s+(.+?)\s+else\s+(\S+)\s*\)$/.exec(expr.trim());
  if (!m) return expr.trim();
  const [, yes = "", cond = "", no = ""] = m;
  const ok = cond.split("&&").every((raw) => {
    const c = raw.trim();
    const ram = /^ram\s*>=\s*(\d+(?:\.\d+)?)$/.exec(c);
    if (ram) return hw.ramGb >= Number(ram[1]);
    // Integrated graphics don't count: only CUDA (or, later, Apple Silicon unified memory).
    if (c === "gpu") return hw.cuda;
    throw new Error(`Unknown tier condition "${c}" in ${expr}`);
  });
  return ok ? yes : no;
}

export function toTarget(policy: PolicyFile, alias: string): Target {
  const id = policy.models[alias];
  if (!id) throw new Error(`Model alias "${alias}" is not defined in policies.yaml`);
  const slash = id.indexOf("/");
  const provider = id.slice(0, slash);
  return {
    alias,
    provider,
    model: id.slice(slash + 1),
    local: LOCAL_PROVIDERS.has(provider),
    options: policy.model_options[id] ?? {},
  };
}

export interface ResolveContext {
  hardware: Pick<Hardware, "ramGb" | "ramTier" | "gpus" | "cuda">;
  localOnly: boolean;
  examGrade?: boolean;
}

/**
 * Resolution order (router.md): policy (already layered) → tier aliases → hardware profile →
 * local-only. Returns the ordered chain of targets to try.
 */
export function resolveChain(policy: PolicyFile, task: Task, ctx: ResolveContext): Target[] {
  const tp = policy.tasks[task];
  if (!tp) throw new Error(`No policy for task "${task}"`);
  const primary = ctx.examGrade && tp.exam_grade ? tp.exam_grade : tp.primary;
  const aliases = [primary, tp.fallback]
    .filter((a): a is string => Boolean(a))
    .map((a) => evalTier(a, ctx.hardware));
  let chain = [...new Set(aliases)].map((a) => toTarget(policy, a));

  if (!tp.local_allowed) chain = chain.filter((t) => !t.local);
  // Low-RAM machines run every LLM task on API (embeddings and transcription aren't routed here).
  if (ctx.hardware.ramTier === "low" && !ctx.localOnly) {
    const api = chain.filter((t) => !t.local);
    if (api.length) chain = api;
  }
  if (ctx.localOnly) {
    chain = chain.filter((t) => t.local);
    if (chain.length === 0) throw new TaskNeedsApi(task);
  }
  return chain;
}

/** Parses `input_tokens>12000` and `timeout_60s` escalation rules. */
export function escalationLimits(tp: TaskPolicy | undefined): {
  maxLocalInputTokens?: number;
  timeoutMs?: number;
} {
  const out: { maxLocalInputTokens?: number; timeoutMs?: number } = {};
  for (const rule of tp?.escalate_on ?? []) {
    const it = /^input_tokens>(\d+)$/.exec(rule);
    if (it) out.maxLocalInputTokens = Number(it[1]);
    const to = /^timeout_(\d+)s$/.exec(rule);
    if (to) out.timeoutMs = Number(to[1]) * 1000;
  }
  return out;
}

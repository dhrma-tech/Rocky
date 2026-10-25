import type { Hardware, Origin, PathInfo, RoutingMode, Task, Usage } from "@rocky/contracts";
import type { ZodType } from "zod";
import {
  BudgetExceeded,
  isPolicyError,
  MissingApiKey,
  ProviderFailure,
  TaskNeedsApi,
  TaskNeedsCloud,
} from "./errors.ts";
import type { ProviderGate } from "./gate.ts";
import { escalationLimits, type PolicyFile, resolveChain, type Target } from "./policy.ts";
import { estimateTokens } from "./prices.ts";

export interface RunRequest<T> {
  task: Task;
  origin: Origin;
  system: string;
  /** Untrusted parts must already be wrapped (security/untrusted.ts). */
  prompt: string;
  schema?: ZodType<T>;
  scope?: { localOnly?: boolean; notebookId?: string };
  hints?: { examGrade?: boolean; maxTokens?: number; timeoutMs?: number; temperature?: number };
  /**
   * Roadmap M4 (D-068). "local": local targets only. "cloud": cloud targets first, and `consent`
   * (an accepted preview's token) goes to the gate, which checks it. Omitted: policies.yaml,
   * kept local under local first.
   */
  route?: "local" | "cloud";
  consent?: string;
}

export interface RunResult<T> {
  output: T;
  path: PathInfo;
  usage: Usage;
}

export interface RouterDeps {
  gate: ProviderGate;
  policy: (notebookId?: string) => PolicyFile;
  hardware: () => Pick<Hardware, "ramGb" | "ramTier" | "gpus" | "cuda">;
  globalLocalOnly: () => boolean;
  /** Omitted in older test seams: cloud first. */
  routingMode?: () => RoutingMode;
}

const DEFAULT_TIMEOUT_MS = { local: 180_000, api: 120_000 };

/** Tasks that send no user content; local first doesn't hold them back (the gate agrees). */
const CONTENT_FREE: ReadonlySet<Task> = new Set(["key_test"]);

const REASON: Record<ProviderFailure["kind"], string> = {
  json_invalid: "json_invalid_x2",
  timeout: "timeout",
  provider_down: "provider_down",
  refusal: "refusal",
  error: "error",
};

/**
 * router.run() (router.md): resolve the policy chain, call each target through the gate,
 * repair invalid structured output once, escalate on failure, and report the path taken.
 * Policy errors (local-only, budget, unknown price) are surfaced, never silently routed around.
 */
export class Router {
  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  mode(): RoutingMode {
    return this.deps.routingMode?.() ?? "cloud_first";
  }

  chain(
    task: Task,
    scope?: RunRequest<unknown>["scope"],
    examGrade?: boolean,
    route?: RunRequest<unknown>["route"],
  ): Target[] {
    const localOnly = this.deps.globalLocalOnly() || Boolean(scope?.localOnly);
    const ctx = { hardware: this.deps.hardware(), localOnly, examGrade: Boolean(examGrade) };
    const policy = this.deps.policy(scope?.notebookId);
    const chain = resolveChain(policy, task, ctx);
    if (route === "cloud")
      return [...chain.filter((t) => !t.local), ...chain.filter((t) => t.local)];
    // Local first keeps everything on this computer (even on a low-RAM machine, which policy
    // would send to the API); a task with no local route says so.
    if ((route === "local" || this.mode() === "local_first") && !CONTENT_FREE.has(task)) {
      try {
        return resolveChain(policy, task, { ...ctx, localOnly: true });
      } catch (err) {
        if (err instanceof TaskNeedsApi && !localOnly) throw new TaskNeedsCloud(task);
        throw err;
      }
    }
    return chain;
  }

  /** The cloud targets a consented question would use, first one first (for the preview). */
  cloudChain(task: Task, scope?: RunRequest<unknown>["scope"]): Target[] {
    if (this.deps.globalLocalOnly() || scope?.localOnly) return [];
    return resolveChain(this.deps.policy(scope?.notebookId), task, {
      hardware: this.deps.hardware(),
      localOnly: false,
    }).filter((t) => !t.local);
  }

  async run<T>(req: RunRequest<T>): Promise<RunResult<T>> {
    const policy = this.deps.policy(req.scope?.notebookId);
    const tp = policy.tasks[req.task];
    const chain = this.chain(req.task, req.scope, req.hints?.examGrade, req.route);
    const limits = escalationLimits(tp);
    const inputTokens = estimateTokens(req.system + req.prompt);
    let reason: string | undefined;
    let attempts = 0;
    let lastError: unknown;

    for (const [i, target] of chain.entries()) {
      const isLast = i === chain.length - 1;
      if (
        target.local &&
        limits.maxLocalInputTokens &&
        inputTokens > limits.maxLocalInputTokens &&
        !isLast
      ) {
        reason ??= `input_tokens>${limits.maxLocalInputTokens}`;
        continue;
      }
      const base = {
        task: req.task,
        origin: req.origin,
        system: req.system,
        maxTokens: req.hints?.maxTokens ?? tp?.max_tokens ?? 2000,
        timeoutMs:
          req.hints?.timeoutMs ??
          limits.timeoutMs ??
          (target.local ? DEFAULT_TIMEOUT_MS.local : DEFAULT_TIMEOUT_MS.api),
        localOnly: Boolean(req.scope?.localOnly),
        ...(req.route === "cloud" && req.consent ? { cloudConsent: req.consent } : {}),
        ...(req.schema ? { schema: req.schema } : {}),
        ...(req.hints?.temperature !== undefined ? { temperature: req.hints.temperature } : {}),
      };
      try {
        attempts++;
        try {
          const r = await this.deps.gate.call(target, { ...base, prompt: req.prompt });
          return done(r, target, attempts, reason);
        } catch (err) {
          if (!(err instanceof ProviderFailure && err.kind === "json_invalid")) throw err;
          // One repair retry with the validation errors appended (router.md).
          attempts++;
          const repair = `${req.prompt}\n\nYour previous reply was rejected: ${err.message}\nReply again with JSON that matches the schema exactly.`;
          const r = await this.deps.gate.call(target, { ...base, prompt: repair });
          return done(r, target, attempts, reason);
        }
      } catch (err) {
        // A budget block on an API target with a local fallback is still a block: the UI offers local mode.
        if (isPolicyError(err) || err instanceof BudgetExceeded) throw err;
        lastError = err;
        if (err instanceof ProviderFailure)
          reason ??= `${REASON[err.kind]}${err.kind === "timeout" ? `_${Math.round(base.timeoutMs / 1000)}s` : ""}`;
        else if (err instanceof MissingApiKey) reason ??= "missing_api_key";
        else reason ??= "error";
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`All routes failed for task ${req.task}`);
  }
}

function done<T>(
  r: { output: T; inputTokens: number; outputTokens: number; costUsd: number },
  t: Target,
  attempts: number,
  reason: string | undefined,
): RunResult<T> {
  return {
    output: r.output,
    path: {
      provider: t.provider,
      model: t.model,
      local: t.local,
      attempts,
      ...(reason ? { fallbackReason: reason } : {}),
    },
    usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd },
  };
}

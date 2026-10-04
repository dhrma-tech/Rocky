// ProviderGate: the ONLY module allowed to import provider SDKs (biome noRestrictedImports).
// Every network model call passes through call(), which enforces local-only and the budget cap
// before anything leaves the machine, then records usage and an audit event (router.md).
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Origin, Task } from "@rocky/contracts";
import { generateText, type LanguageModel, Output } from "ai";
import { ulid } from "ulid";
import type { ZodType } from "zod";
import { appendAudit } from "../audit/append.ts";
import type { SecretStore } from "../secrets/keychain.ts";
import type { Db } from "../store/db.ts";
import {
  BudgetExceeded,
  EgressBlocked,
  MissingApiKey,
  ProviderFailure,
  UnknownPrice,
} from "./errors.ts";
import type { Target } from "./policy.ts";
import { costUsd, estimateTokens, monthSpend, type PriceTable } from "./prices.ts";

export interface GateRequest<T> {
  task: Task;
  origin: Origin;
  system: string;
  prompt: string;
  schema?: ZodType<T>;
  maxTokens: number;
  timeoutMs: number;
  /** Scope or notebook local-only; OR-ed with the global setting. */
  localOnly?: boolean;
  temperature?: number;
}

export interface GateResult<T> {
  output: T;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GateConfig {
  /** Read on every call so Settings changes apply immediately. */
  settings: () => { localOnly: boolean; monthlyCapUsd: number; ollamaBaseUrl: string };
  prices: () => PriceTable;
  secrets: SecretStore;
  /** Injected in tests; also covers every provider's HTTP. */
  fetch?: typeof fetch;
  now?: () => number;
}

export class ProviderGate {
  private readonly db: Db;
  private readonly cfg: GateConfig;

  constructor(db: Db, cfg: GateConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  /** Throws EgressBlocked / UnknownPrice / BudgetExceeded without making any request. */
  preflight(
    target: Target,
    req: Pick<GateRequest<unknown>, "system" | "prompt" | "maxTokens" | "localOnly">,
  ): void {
    const s = this.cfg.settings();
    if (!target.local && (s.localOnly || req.localOnly)) {
      appendAudit(this.db, {
        eventType: "egress_blocked",
        actor: "system",
        meta: { provider: target.provider, model: target.model },
      });
      throw new EgressBlocked(
        target.provider,
        s.localOnly ? "global setting" : "scope or notebook",
      );
    }
    if (target.local || s.monthlyCapUsd <= 0) return;
    const price = this.cfg.prices()[`${target.provider}/${target.model}`];
    if (!price) throw new UnknownPrice(`${target.provider}/${target.model}`);
    const estimate = costUsd(price, estimateTokens(req.system + req.prompt), req.maxTokens);
    const spent = monthSpend(this.db, this.now());
    if (spent + estimate > s.monthlyCapUsd) {
      appendAudit(this.db, {
        eventType: "budget_blocked",
        actor: "system",
        meta: {
          provider: target.provider,
          model: target.model,
          capUsd: s.monthlyCapUsd,
          spentUsd: spent,
          estimateUsd: estimate,
        },
      });
      throw new BudgetExceeded(s.monthlyCapUsd, spent, estimate);
    }
  }

  async call<T>(target: Target, req: GateRequest<T>): Promise<GateResult<T>> {
    this.preflight(target, req);
    const model = this.model(target);
    let res: Awaited<ReturnType<typeof generateText>>;
    try {
      res = await generateText({
        model,
        system: req.system,
        prompt: req.prompt,
        maxOutputTokens: req.maxTokens,
        abortSignal: AbortSignal.timeout(req.timeoutMs),
        maxRetries: 1,
        // Claude Sonnet 5.5 rejects non-default sampling parameters (400).
        ...(req.temperature !== undefined && target.provider !== "anthropic"
          ? { temperature: req.temperature }
          : {}),
        ...(req.schema ? { output: Output.object({ schema: req.schema }) } : {}),
      });
    } catch (err) {
      throw classify(err, target);
    }
    if (res.finishReason === "content-filter")
      throw new ProviderFailure("refusal", `${target.model} declined the request`);

    const inputTokens = res.usage.inputTokens ?? 0;
    const outputTokens = res.usage.outputTokens ?? 0;
    const price = this.cfg.prices()[`${target.provider}/${target.model}`];
    const cost = target.local || !price ? 0 : costUsd(price, inputTokens, outputTokens);
    this.record(target, req, inputTokens, outputTokens, cost);
    return {
      output: (req.schema ? res.output : res.text) as T,
      inputTokens,
      outputTokens,
      costUsd: cost,
    };
  }

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  private record(
    target: Target,
    req: GateRequest<unknown>,
    inputTokens: number,
    outputTokens: number,
    cost: number,
  ): void {
    const at = this.now();
    this.db
      .prepare(
        `insert into usage_log (id, at, task, provider, model, local, input_tokens, output_tokens, cost_usd)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(at),
        at,
        req.task,
        target.provider,
        target.model,
        target.local ? 1 : 0,
        inputTokens,
        outputTokens,
        cost,
      );
    // Metadata only: never prompt or output content.
    appendAudit(this.db, {
      eventType: "model_call",
      actor: req.origin.startsWith("routine:")
        ? "routine"
        : req.origin === "user_turn"
          ? "user"
          : "system",
      at,
      meta: {
        task: req.task,
        origin: req.origin,
        provider: target.provider,
        model: target.model,
        local: target.local,
        inputTokens,
        outputTokens,
        costUsd: cost,
      },
    });
  }

  private model(t: Target): LanguageModel {
    const fetch = this.cfg.fetch;
    switch (t.provider) {
      case "anthropic": {
        const apiKey = this.cfg.secrets.get("anthropic");
        if (!apiKey) throw new MissingApiKey("anthropic");
        return createAnthropic({ apiKey, ...(fetch ? { fetch } : {}) })(t.model);
      }
      case "google": {
        const apiKey = this.cfg.secrets.get("google");
        if (!apiKey) throw new MissingApiKey("google");
        return createGoogleGenerativeAI({ apiKey, ...(fetch ? { fetch } : {}) })(t.model);
      }
      case "ollama": {
        const opts = t.options;
        return createOpenAICompatible({
          name: "ollama",
          baseURL: new URL("/v1", this.cfg.settings().ollamaBaseUrl).toString(),
          supportsStructuredOutputs: true,
          ...(fetch ? { fetch } : {}),
          transformRequestBody: (body) => ({ ...body, ...opts }),
        })(t.model);
      }
      default:
        throw new Error(`Unknown provider "${t.provider}"`);
    }
  }
}

function classify(err: unknown, t: Target): Error {
  if (err instanceof MissingApiKey) return err;
  const e = err as { name?: string; message?: string; cause?: unknown; statusCode?: number };
  const text = `${e.name ?? ""} ${e.message ?? ""} ${String((e.cause as { code?: string } | undefined)?.code ?? "")}`;
  if (/TimeoutError|AbortError|aborted due to timeout/i.test(text))
    return new ProviderFailure("timeout", `${t.model} timed out`);
  if (
    /NoObjectGenerated|NoOutputGenerated|TypeValidation|JSONParse|did not match schema/i.test(text)
  )
    return new ProviderFailure(
      "json_invalid",
      `${t.model} returned invalid structured output: ${(e.message ?? "").slice(0, 500)}`,
    );
  if (
    /ECONNREFUSED|ENOTFOUND|fetch failed|ECONNRESET|socket hang up/i.test(text) ||
    (e.statusCode ?? 0) >= 500
  )
    return new ProviderFailure(
      "provider_down",
      `${t.provider} is unreachable: ${(e.message ?? "").slice(0, 200)}`,
    );
  return new ProviderFailure(
    "error",
    `${t.provider} error: ${(e.message ?? String(err)).slice(0, 500)}`,
  );
}

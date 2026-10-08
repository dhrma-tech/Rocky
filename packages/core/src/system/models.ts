import fs from "node:fs";
import path from "node:path";
import type { Hardware } from "@rocky/contracts";
import { z } from "zod";

/**
 * Hardware-aware model setup (roadmap A8). Rocky only recommends models that are already
 * installed in Ollama, so it never names a model it can't show exists. Fit is a rule of thumb
 * from model size against memory; speed is measured on this machine (`rocky models bench`).
 */

const TagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      details: z
        .object({
          parameter_size: z.string().optional(),
          quantization_level: z.string().optional(),
          family: z.string().optional(),
        })
        .partial()
        .optional(),
      capabilities: z.array(z.string()).optional(),
    }),
  ),
});

export interface LocalModel {
  name: string;
  sizeGb: number;
  parameters: string | null;
  quantization: string | null;
  /** Embedding-only models can't answer. */
  canAnswer: boolean;
}

export type Fit = "fits" | "tight" | "too-big";

export interface ModelAdvice extends LocalModel {
  fit: Fit;
  why: string;
}

export async function listLocalModels(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<LocalModel[]> {
  const res = await doFetch(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const seen = new Set<string>();
  return (
    TagsSchema.parse(await res.json())
      // Newer Ollama also lists its internal blobs as llamacpp:<sha256>; they are not models to pick.
      .models.filter((m) => !/^llamacpp:[0-9a-f]{64}$/.test(m.name))
      .map((m) => ({ ...m, name: m.name.replace(/:latest$/, "") }))
      .filter((m) => !seen.has(m.name) && seen.add(m.name))
      .map((m) => ({
        name: m.name,
        sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10,
        parameters: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        canAnswer: m.capabilities
          ? m.capabilities.includes("completion")
          : !/embed/i.test(`${m.name} ${m.details?.family ?? ""}`),
      }))
  );
}

/**
 * Rule of thumb: without a CUDA GPU the model shares RAM with the OS, Rocky and the browser, so
 * it fits under 45% of RAM and is tight under 60%. With a CUDA GPU the same limits apply, but
 * layers can also go to the GPU, so the advice says to check GPU memory.
 */
export function fitOf(
  model: LocalModel,
  hw: Pick<Hardware, "ramGb" | "cuda">,
): { fit: Fit; why: string } {
  const share = model.sizeGb / Math.max(hw.ramGb, 1);
  const pct = Math.round(share * 100);
  const gpu = hw.cuda ? " A CUDA GPU can hold part of it; check its memory." : "";
  if (share <= 0.45)
    return { fit: "fits", why: `${model.sizeGb} GB is ${pct}% of ${hw.ramGb} GB RAM.${gpu}` };
  if (share <= 0.6)
    return {
      fit: "tight",
      why: `${model.sizeGb} GB is ${pct}% of ${hw.ramGb} GB RAM: close other apps while it runs.${gpu}`,
    };
  return {
    fit: "too-big",
    why: `${model.sizeGb} GB is ${pct}% of ${hw.ramGb} GB RAM: too big for this machine.${gpu}`,
  };
}

export interface Recommendation {
  models: ModelAdvice[];
  /** For retrieval checks, tagging and verification: the smallest model that answers. */
  small: string | null;
  /** For writing answers and summaries: the largest model that fits. */
  medium: string | null;
  note: string;
}

export function recommendModels(
  hw: Pick<Hardware, "ramGb" | "cuda">,
  installed: LocalModel[],
): Recommendation {
  const models = installed.map((m) => ({ ...m, ...fitOf(m, hw) }));
  const usable = models
    .filter((m) => m.canAnswer && m.fit !== "too-big")
    .sort((a, b) => a.sizeGb - b.sizeGb);
  const fitting = usable.filter((m) => m.fit === "fits");
  // Among models of the same size, prefer Rocky's 16k-context copies (rocky-*): Ollama loads
  // plain models with a 4096-token context and silently drops the start of longer prompts.
  const pick = (list: ModelAdvice[], size: number | undefined) =>
    size === undefined
      ? null
      : (list
          .filter((m) => m.sizeGb === size)
          .sort(
            (a, b) => Number(b.name.startsWith("rocky-")) - Number(a.name.startsWith("rocky-")),
          )[0]?.name ?? null);
  const small = pick(usable, usable[0]?.sizeGb);
  const top = fitting.length ? fitting : usable;
  const medium = pick(top, top.at(-1)?.sizeGb);
  const note = !installed.some((m) => m.canAnswer)
    ? "No answering model is installed in Ollama yet. Pull one, then run rocky models again."
    : !usable.length
      ? "Every installed model is too big for this machine's RAM. Pull a smaller one."
      : small === medium
        ? "One model does everything. A second, larger model that fits would write better answers."
        : "The small model checks and tags; the larger one writes answers.";
  return { models, small, medium, note };
}

const GenerateSchema = z.object({
  eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  load_duration: z.number().optional(),
  total_duration: z.number().optional(),
});

export interface SpeedProfile {
  measuredAt: number;
  model: string;
  /** Generated tokens per second. */
  tokensPerSecond: number;
  /** Prompt tokens read per second. */
  promptTokensPerSecond: number;
  /** Load plus prompt reading, before the first generated token. */
  firstTokenMs: number;
  /** A 300-word answer at the measured speed, for the speed line in Settings. */
  estimatedAnswerSeconds: number;
  ramGb: number;
  cuda: boolean;
}

const PROMPT =
  "Rocky speed check. Summarise in two sentences why a local assistant should cite its sources. ".repeat(
    8,
  );

/**
 * Measures one model on this machine through Ollama's /api/generate (thinking off, 64 tokens).
 * The first call may include loading the model from disk; that is part of the honest number.
 */
export async function benchModel(
  baseUrl: string,
  model: string,
  hw: Pick<Hardware, "ramGb" | "cuda">,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<SpeedProfile> {
  const res = await (opts.fetch ?? fetch)(new URL("/api/generate", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: PROMPT,
      stream: false,
      think: false,
      options: { num_predict: 64 },
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok)
    throw new Error(
      `Ollama /api/generate returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const g = GenerateSchema.parse(await res.json());
  const sec = (ns = 0) => ns / 1e9;
  const tps = g.eval_count && g.eval_duration ? g.eval_count / sec(g.eval_duration) : 0;
  const pps =
    g.prompt_eval_count && g.prompt_eval_duration
      ? g.prompt_eval_count / sec(g.prompt_eval_duration)
      : 0;
  const firstTokenMs = Math.round(((g.load_duration ?? 0) + (g.prompt_eval_duration ?? 0)) / 1e6);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    measuredAt: (opts.now ?? Date.now)(),
    model,
    tokensPerSecond: round(tps),
    promptTokensPerSecond: round(pps),
    firstTokenMs,
    // ~400 tokens for 300 words, plus about 3k prompt tokens of retrieved context.
    estimatedAnswerSeconds: tps > 0 && pps > 0 ? Math.round(400 / tps + 3000 / pps) : 0,
    ramGb: hw.ramGb,
    cuda: hw.cuda,
  };
}

const profileFile = (dataDir: string) => path.join(dataDir, "speed-profile.json");

export function saveSpeedProfile(dataDir: string, p: SpeedProfile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(profileFile(dataDir), JSON.stringify(p, null, 2));
}

export function loadSpeedProfile(dataDir: string): SpeedProfile | null {
  try {
    return JSON.parse(fs.readFileSync(profileFile(dataDir), "utf8")) as SpeedProfile;
  } catch {
    return null;
  }
}

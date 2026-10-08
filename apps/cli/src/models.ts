import {
  benchModel,
  detectHardware,
  listLocalModels,
  loadAppConfig,
  loadPolicy,
  loadSpeedProfile,
  recommendModels,
  resolveDataDir,
  saveSpeedProfile,
  updateUserYaml,
} from "@rocky/core";

/**
 * `rocky models [list | bench | use --small <name> --medium <name>]` (roadmap A8).
 * list: installed Ollama models, whether each fits this machine, and the recommendation.
 * bench: measures the medium model on this machine and saves the speed profile.
 * use: writes the choice to <data>/config/policies.yaml (the user's override; repo defaults stay).
 */
export async function modelsCommand(
  action: string | undefined,
  opts: { dataDir?: string | undefined; small?: string; medium?: string; json?: boolean },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const config = loadAppConfig(dir);
  const hw = await detectHardware();
  let installed: Awaited<ReturnType<typeof listLocalModels>>;
  try {
    installed = await listLocalModels(config.ollama.baseUrl);
  } catch (err) {
    console.error(
      `Ollama isn't reachable at ${config.ollama.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const rec = recommendModels(hw, installed);
  const policy = loadPolicy(dir);
  const current = {
    small: policy.models["local:small"]?.replace(/^ollama\//, "") ?? null,
    medium: policy.models["local:medium"]?.replace(/^ollama\//, "") ?? null,
  };

  if (!action || action === "list") {
    if (opts.json) {
      console.log(
        JSON.stringify({ hardware: hw, current, ...rec, speed: loadSpeedProfile(dir) }, null, 2),
      );
      return 0;
    }
    console.log(
      `This machine: ${hw.ramGb} GB RAM, ${hw.cuda ? "CUDA GPU" : "no CUDA GPU"}, ${hw.cores} cores.`,
    );
    for (const m of rec.models)
      console.log(
        `  ${m.fit.padEnd(7)} ${m.name.padEnd(32)} ${m.canAnswer ? m.why : "embedding model (not for answers)"}`,
      );
    console.log(`\nIn use:      small ${current.small ?? "-"}, medium ${current.medium ?? "-"}`);
    console.log(`Recommended: small ${rec.small ?? "-"}, medium ${rec.medium ?? "-"}`);
    console.log(rec.note);
    const speed = loadSpeedProfile(dir);
    console.log(
      speed
        ? `Measured ${new Date(speed.measuredAt).toLocaleString()}: ${speed.model} writes ${speed.tokensPerSecond} tokens/s and reads ${speed.promptTokensPerSecond} tokens/s; a typical answer takes about ${speed.estimatedAnswerSeconds} s.`
        : "Not measured yet: run rocky models bench.",
    );
    return 0;
  }

  if (action === "bench") {
    const model = opts.medium ?? current.medium ?? rec.medium;
    if (!model) {
      console.error("No model to measure. Pull one into Ollama first.");
      return 1;
    }
    console.error(`Measuring ${model} on this machine (the first run includes loading it)…`);
    const p = await benchModel(config.ollama.baseUrl, model, hw);
    saveSpeedProfile(dir, p);
    console.log(
      `${model}: ${p.tokensPerSecond} tokens/s written, ${p.promptTokensPerSecond} tokens/s read, first token after ${p.firstTokenMs} ms. A typical cited answer takes about ${p.estimatedAnswerSeconds} s here.`,
    );
    return 0;
  }

  if (action === "use") {
    const small = opts.small ?? rec.small;
    const medium = opts.medium ?? rec.medium;
    const names = new Set(installed.map((m) => m.name));
    for (const n of [small, medium])
      if (!n || !names.has(n)) {
        console.error(
          `${n ?? "(none)"} is not installed in Ollama. Installed: ${[...names].join(", ")}`,
        );
        return 1;
      }
    for (const n of [small, medium])
      if (n && !n.startsWith("rocky-"))
        console.error(
          `Note: Ollama runs ${n} with a 4096-token context and drops the start of longer prompts. Add it under ollama_models in policies.yaml and run rocky doctor --fix to make a 16k copy.`,
        );
    const file = updateUserYaml("policies", dir, {
      models: { "local:small": `ollama/${small}`, "local:medium": `ollama/${medium}` },
    });
    console.log(
      `Saved to ${file}: small ${small}, medium ${medium}. The daemon picks it up on restart.`,
    );
    return 0;
  }

  console.error(`Unknown action "${action}". Use: list | bench | use`);
  return 1;
}

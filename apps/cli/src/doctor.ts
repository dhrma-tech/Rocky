import type { DoctorCheck, DoctorReport } from "@rocky/contracts";
import {
  benchModel,
  createDerivedModel,
  detectHardware,
  hasModel,
  installFfmpeg,
  installWhisper,
  loadAppConfig,
  loadPolicy,
  loadSpeedProfile,
  ollamaStatus,
  resolveDataDir,
  runDoctor,
  saveSpeedProfile,
} from "@rocky/core";
import { autostartStatus, installAutostart } from "./autostart.ts";

const TAG = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;

export function formatReport(r: DoctorReport): string {
  const width = Math.max(...r.checks.map((c) => c.label.length));
  const lines = r.checks.map((c) => {
    const row = `  [${TAG[c.status]}] ${c.label.padEnd(width)}  ${c.detail}`;
    if (!c.hint || c.status === "pass") return row;
    return `${row}\n         ${" ".repeat(width)}  -> ${c.hint}`;
  });
  const summary = r.ok ? "All required checks passed." : "Some required checks failed.";
  return ["Rocky doctor", ...lines, "", summary].join("\n");
}

export async function doctorCommand(opts: {
  json?: boolean;
  fix?: boolean;
  bench?: boolean;
  dataDir?: string | undefined;
}): Promise<number> {
  const { dir, source } = resolveDataDir({ flag: opts.dataDir });
  const config = loadAppConfig(dir);
  const derivedModels = loadPolicy(dir).ollama_models;
  if (opts.fix) {
    const res = await installWhisper(dir, config.whisper.model, (m) => console.error(m));
    console.error(`whisper-cli: ${res.binary}\nmodel: ${res.model}`);
    try {
      console.error(`ffmpeg: ${await installFfmpeg(dir, (m) => console.error(m))}`);
    } catch (err) {
      // ffmpeg is only needed for media import; keep going so the report still prints.
      console.error(`ffmpeg: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ollama = await ollamaStatus(config.ollama.baseUrl);
    for (const [name, spec] of Object.entries(derivedModels)) {
      if (!ollama.ok || hasModel(ollama.models, name) || !hasModel(ollama.models, spec.from))
        continue;
      await createDerivedModel(config.ollama.baseUrl, name, spec);
      console.error(`ollama: created ${name} (${spec.from}, num_ctx ${spec.num_ctx})`);
    }
  }
  // Roadmap I3: --fix also makes the daemon start at sign-in, so it works while you are busy.
  let autostart = await autostartStatus();
  if (opts.fix && !autostart.installed) {
    try {
      console.error(await installAutostart(dir));
      autostart = await autostartStatus();
    } catch (err) {
      console.error(`autostart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const report = await runDoctor({
    dataDir: dir,
    dataDirSource: source,
    config,
    derivedModels,
    bench: Boolean(opts.bench || opts.fix),
  });
  report.checks.push(autostartCheck(autostart));
  // Roadmap A8: measured answer speed on this machine (with --bench or --fix), else the last one.
  if (opts.bench || opts.fix) {
    const model = loadPolicy(dir).models["local:medium"]?.replace(/^ollama\//, "");
    if (model)
      try {
        saveSpeedProfile(
          dir,
          await benchModel(config.ollama.baseUrl, model, await detectHardware()),
        );
      } catch (err) {
        console.error(`model speed: ${err instanceof Error ? err.message : String(err)}`);
      }
  }
  report.checks.push(speedCheck(loadSpeedProfile(dir)));
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

/** Optional, so it warns rather than fails: Rocky works without starting at sign-in. */
export function autostartCheck(a: { installed: boolean; where: string }): DoctorCheck {
  return a.installed
    ? { id: "autostart", label: "Starts at sign-in", status: "pass", detail: a.where }
    : {
        id: "autostart",
        label: "Starts at sign-in",
        status: "warn",
        detail: "not set up; routines and syncs run only while the daemon is running",
        hint: "rocky doctor --fix, or rocky daemon install",
      };
}

export function speedCheck(p: ReturnType<typeof loadSpeedProfile>): DoctorCheck {
  if (!p)
    return {
      id: "answer-speed",
      label: "Answer speed",
      status: "warn",
      detail: "not measured on this machine",
      hint: "rocky models bench (or rocky doctor --bench)",
    };
  return {
    id: "answer-speed",
    label: "Answer speed",
    status: "pass",
    detail: `${p.model}: ${p.tokensPerSecond} tokens/s; a cited answer takes about ${p.estimatedAnswerSeconds} s`,
  };
}

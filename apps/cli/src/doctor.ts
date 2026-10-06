import type { DoctorReport } from "@rocky/contracts";
import {
  createDerivedModel,
  hasModel,
  installFfmpeg,
  installWhisper,
  loadAppConfig,
  loadPolicy,
  ollamaStatus,
  resolveDataDir,
  runDoctor,
} from "@rocky/core";

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
  const report = await runDoctor({
    dataDir: dir,
    dataDirSource: source,
    config,
    derivedModels,
    bench: Boolean(opts.bench || opts.fix),
  });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

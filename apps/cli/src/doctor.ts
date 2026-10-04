import type { DoctorReport } from "@rocky/contracts";
import { installWhisper, loadAppConfig, resolveDataDir, runDoctor } from "@rocky/core";

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
  dataDir?: string | undefined;
}): Promise<number> {
  const { dir, source } = resolveDataDir({ flag: opts.dataDir });
  const config = loadAppConfig(dir);
  if (opts.fix) {
    const res = await installWhisper(dir, config.whisper.model, (m) => console.error(m));
    console.error(`whisper-cli: ${res.binary}\nmodel: ${res.model}`);
  }
  const report = await runDoctor({ dataDir: dir, dataDirSource: source, config });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

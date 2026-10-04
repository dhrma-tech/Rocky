import os from "node:os";
import type { Hardware } from "@rocky/contracts";
import { tryExec } from "./exec.ts";

/** GB tiers from specs/router.md; >=15 counts as "16 GB" since such machines report ~15.7. */
export function ramTier(gb: number): Hardware["ramTier"] {
  if (gb < 12) return "low";
  if (gb < 15) return "mid";
  return "high";
}

async function detectGpus(platform: NodeJS.Platform): Promise<string[]> {
  if (platform === "win32") {
    const out = await tryExec("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress",
    ]);
    if (!out?.trim()) return [];
    const parsed: unknown = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String);
  }
  // macOS and Linux detection is stubbed in Phase 0 (PLAN: cut if over).
  return [];
}

export async function detectHardware(
  platform: NodeJS.Platform = process.platform,
): Promise<Hardware> {
  const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const [gpus, smi] = await Promise.all([detectGpus(platform), tryExec("nvidia-smi", ["-L"])]);
  return {
    platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores: os.availableParallelism(),
    ramGb,
    ramTier: ramTier(ramGb),
    gpus,
    cuda: smi?.includes("GPU") ?? false,
  };
}

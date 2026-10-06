import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadLayeredYaml } from "../config/load.ts";
import { dataPaths } from "../config/paths.ts";
import { type ProcessRunner, runProcess, tryExec } from "../system/exec.ts";
import { downloadVerified, findFile } from "../system/whisper.ts";

const Pinned = z.object({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const ToolsSchema = z.object({
  ffmpeg: z.object({ version: z.string(), binaries: z.record(z.string(), Pinned) }),
});

const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/** The data dir's own copy first (installed by `doctor --fix`), then PATH. Null when neither works. */
export async function resolveFfmpeg(dataDir: string): Promise<string | null> {
  const local = findFile(path.join(dataPaths(dataDir).bin, "ffmpeg"), exe);
  if (local) return local;
  return (await tryExec("ffmpeg", ["-hide_banner", "-version"], 8000)) === null ? null : "ffmpeg";
}

export async function installFfmpeg(
  dataDir: string,
  log: (msg: string) => void = () => {},
): Promise<string> {
  const existing = await resolveFfmpeg(dataDir);
  if (existing) return existing;
  const tools = ToolsSchema.parse(loadLayeredYaml("tools", dataDir)).ffmpeg;
  const key = `${process.platform}-${process.arch}`;
  const pin = tools.binaries[key];
  const binDir = path.join(dataPaths(dataDir).bin, "ffmpeg");
  if (!pin)
    throw new Error(`No pinned ffmpeg build for ${key}. Install ffmpeg and put it on PATH.`);
  const zip = path.join(binDir, `ffmpeg-${tools.version}.zip`);
  log(`Downloading ffmpeg ${tools.version} (LGPL, ~170 MB)…`);
  await downloadVerified(pin.url, pin.sha256, zip);
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const out = await tryExec(tar, ["-xf", zip, "-C", binDir], 300_000);
  fs.rmSync(zip, { force: true });
  const binary = findFile(binDir, exe);
  if (out === null || !binary) throw new Error("Could not extract ffmpeg from the archive");
  return binary;
}

const hms = (h: string, m: string, s: string) =>
  (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;

/** `Duration: 01:02:03.45` (input header) → ms. */
export function parseDuration(line: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  return m ? hms(m[1] as string, m[2] as string, m[3] as string) : null;
}

/** `time=00:00:12.34` (progress line) → ms. */
export function parseTime(line: string): number | null {
  const m = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  return m ? hms(m[1] as string, m[2] as string, m[3] as string) : null;
}

/** Argument list for converting any media file to 16 kHz mono 16-bit WAV, audio only. */
export const toWavArgs = (input: string, outWav: string) => [
  "-nostdin",
  "-hide_banner",
  "-y",
  "-i",
  input,
  "-vn",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  outWav,
];

/** Converts media to whisper's input format. Reports progress 0..1 from ffmpeg's stderr. */
export async function toWav16k(
  ffmpeg: string,
  input: string,
  outWav: string,
  opts: { onProgress?: (p: number) => void; run?: ProcessRunner } = {},
): Promise<void> {
  let total: number | null = null;
  const res = await (opts.run ?? runProcess)(ffmpeg, toWavArgs(input, outWav), {
    onStderrLine: (l) => {
      total ??= parseDuration(l);
      const t = parseTime(l);
      if (t !== null && total) opts.onProgress?.(Math.min(1, t / total));
    },
  });
  if (res.code !== 0 || !fs.existsSync(outWav))
    throw new Error(
      `ffmpeg could not read this file (exit ${res.code}): ${res.stderrTail.trim().split(/\r?\n/).slice(-2).join(" | ")}`,
    );
}

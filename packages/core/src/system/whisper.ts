import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { loadLayeredYaml } from "../config/load.ts";
import { dataPaths } from "../config/paths.ts";
import { tryExec } from "./exec.ts";

const Pinned = z.object({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const ToolsSchema = z.object({
  whisper: z.object({
    version: z.string(),
    binaries: z.record(z.string(), Pinned),
    models: z.record(z.string(), Pinned),
  }),
});
export type WhisperModel = "base" | "small";

const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

export function findFile(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

export function whisperPaths(dataDir: string, model: WhisperModel) {
  const { bin, models } = dataPaths(dataDir);
  const binDir = path.join(bin, "whisper");
  return {
    binDir,
    binary: findFile(binDir, exe),
    model: path.join(models, `ggml-${model}.bin`),
  };
}

export function whisperStatus(dataDir: string, model: WhisperModel) {
  const p = whisperPaths(dataDir, model);
  return { binary: p.binary, model: fs.existsSync(p.model) ? p.model : null };
}

/** Streams `url` to `dest`, verifying sha256 before the file is moved into place. */
export async function downloadVerified(url: string, sha256: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, fs.createWriteStream(part));
  const got = hash.digest("hex");
  if (got !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${got}`);
  }
  fs.renameSync(part, dest);
}

/** Installs the pinned whisper-cli and model into the data dir. Windows x64 only in Phase 0. */
export async function installWhisper(
  dataDir: string,
  model: WhisperModel,
  log: (msg: string) => void = () => {},
): Promise<{ binary: string; model: string }> {
  const tools = ToolsSchema.parse(loadLayeredYaml("tools", dataDir)).whisper;
  const p = whisperPaths(dataDir, model);

  let binary = p.binary;
  if (!binary) {
    const key = `${process.platform}-${process.arch}`;
    const pin = tools.binaries[key];
    if (!pin)
      throw new Error(
        `No pinned whisper-cli build for ${key}. Install whisper-cli manually into ${p.binDir}.`,
      );
    const zip = path.join(p.binDir, `whisper-${tools.version}.zip`);
    log(`Downloading whisper-cli ${tools.version}…`);
    await downloadVerified(pin.url, pin.sha256, zip);
    // Windows 10+ ships bsdtar, which extracts zip. Use its absolute path: a GNU tar from
    // Git or MSYS earlier on PATH cannot read zip archives.
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const out = await tryExec(tar, ["-xf", zip, "-C", p.binDir], 120_000);
    fs.rmSync(zip, { force: true });
    binary = findFile(p.binDir, exe);
    if (out === null || !binary)
      throw new Error(`Could not extract ${exe} from the whisper archive`);
  }

  if (!fs.existsSync(p.model)) {
    const pin = tools.models[model];
    if (!pin) throw new Error(`No pinned whisper model "${model}"`);
    log(`Downloading ggml-${model}.bin…`);
    await downloadVerified(pin.url, pin.sha256, p.model);
  }
  return { binary, model: p.model };
}

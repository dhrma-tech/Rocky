// Spike 4: whisper-cli transcribes a WAV on CPU and reports the speed factor.
// Fixture: samples/jfk.wav from whisper.cpp v1.9.2 (11 s, 16 kHz mono, public-domain speech).
// Skipped when `rocky doctor --fix` has not installed the binary and model.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadAppConfig, resolveDataDir, whisperStatus } from "../../src/index.ts";

const run = promisify(execFile);
const wav = path.join(import.meta.dirname, "..", "fixtures", "jfk.wav");
const { dir } = resolveDataDir();
const model = loadAppConfig(dir).whisper.model;
const status = whisperStatus(dir, model);

/** 16-bit mono PCM: seconds = data bytes / (rate * 2). Header is 44 bytes for this fixture. */
function wavSeconds(file: string): number {
  const buf = fs.readFileSync(file);
  return (buf.length - 44) / (buf.readUInt32LE(24) * 2);
}

describe.skipIf(!status.binary || !status.model)("spike: whisper-cli", () => {
  it("transcribes the fixture and reports a speed factor", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-whisper-"));
    const threads = Math.min(8, os.availableParallelism());
    const t0 = performance.now();
    await run(
      status.binary as string,
      [
        "-m",
        status.model as string,
        "-f",
        wav,
        "-oj",
        "-of",
        path.join(out, "r"),
        "-np",
        "-t",
        String(threads),
        "-l",
        "en",
      ],
      { windowsHide: true, timeout: 170_000 },
    );
    const seconds = (performance.now() - t0) / 1000;
    const json = JSON.parse(fs.readFileSync(path.join(out, "r.json"), "utf8")) as {
      transcription: { text: string; offsets: { from: number; to: number } }[];
    };
    fs.rmSync(out, { recursive: true, force: true });

    const text = json.transcription
      .map((s) => s.text)
      .join(" ")
      .toLowerCase();
    expect(text).toContain("ask not what your country can do for you");
    expect(json.transcription[0]?.offsets.from).toBeGreaterThanOrEqual(0);

    const audio = wavSeconds(wav);
    console.info(
      `whisper ggml-${model}: ${audio.toFixed(1)} s audio in ${seconds.toFixed(1)} s ` +
        `(speed factor ${(audio / seconds).toFixed(2)}x, ${threads} threads)`,
    );
  });
});

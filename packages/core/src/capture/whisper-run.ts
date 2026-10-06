import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ProcessRunner, runProcess } from "../system/exec.ts";

export interface WhisperSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Mean log-probability of the segment's text tokens; null when whisper gave no tokens. */
  avgLogprob: number | null;
}

export interface TranscribeOptions {
  binary: string;
  model: string;
  /** 0 = cores - 2. */
  threads?: number;
  language?: "auto" | "en";
  /** 0..1 as whisper reports it. */
  onProgress?: (p: number) => void;
  run?: ProcessRunner;
  signal?: AbortSignal;
}

/** whisper-cli v1.9.2 prints `whisper_print_progress_callback: progress = 40%` on stderr with -pp. */
export function parseProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d{1,3})%/.exec(line);
  return m ? Math.min(100, Number(m[1])) / 100 : null;
}

interface WhisperJson {
  transcription?: {
    offsets: { from: number; to: number };
    text: string;
    tokens?: { text: string; p: number }[];
  }[];
}

/** Non-speech markers whisper emits for silence or music: "[BLANK_AUDIO]", "(music)", "[Applause]". */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/;

/** Parses `-ojf` output into segments, dropping empty and non-speech ones. */
export function parseWhisperJson(raw: string): WhisperSegment[] {
  const json = JSON.parse(raw) as WhisperJson;
  const out: WhisperSegment[] = [];
  for (const s of json.transcription ?? []) {
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text || NON_SPEECH.test(text)) continue;
    const toks = (s.tokens ?? []).filter((t) => !/^\[_.*_?\]$/.test(t.text) && t.p > 0);
    const avgLogprob = toks.length
      ? toks.reduce((a, t) => a + Math.log(t.p), 0) / toks.length
      : null;
    out.push({ startMs: s.offsets.from, endMs: s.offsets.to, text, avgLogprob });
  }
  return out;
}

export const defaultThreads = (n = 0) => (n > 0 ? n : Math.max(1, os.availableParallelism() - 2));

/** Runs whisper-cli on one 16 kHz mono WAV and returns its timestamped segments. */
export async function transcribeWav(
  wav: string,
  opts: TranscribeOptions,
): Promise<WhisperSegment[]> {
  const outDir = fs.mkdtempSync(path.join(path.dirname(wav), "whisper-"));
  const outBase = path.join(outDir, "r");
  const args = [
    "-m",
    opts.model,
    "-f",
    wav,
    "-oj",
    "-ojf",
    "-of",
    outBase,
    "-pp",
    "-np",
    "-t",
    String(defaultThreads(opts.threads)),
    "-l",
    opts.language ?? "auto",
  ];
  try {
    const res = await (opts.run ?? runProcess)(opts.binary, args, {
      onStderrLine: (l) => {
        const p = parseProgress(l);
        if (p !== null) opts.onProgress?.(p);
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const jsonFile = `${outBase}.json`;
    if (res.code !== 0 || !fs.existsSync(jsonFile))
      throw new Error(
        `whisper-cli failed (exit ${res.code}): ${res.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ")}`,
      );
    return parseWhisperJson(fs.readFileSync(jsonFile, "utf8"));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/** whisper.cpp's public-domain sample (11 s, 16 kHz mono), used to measure transcription speed. */
export const SPEED_SAMPLE = path.join(import.meta.dirname, "..", "..", "assets", "jfk.wav");

/**
 * Audio seconds per wall-clock second on this machine. Below 0.5× a 60-minute lecture takes
 * over two hours, so doctor recommends the `base` model (capture.md).
 */
export async function measureWhisperSpeed(
  opts: Omit<TranscribeOptions, "onProgress">,
): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-speed-"));
  try {
    const wav = path.join(tmp, "sample.wav");
    fs.copyFileSync(SPEED_SAMPLE, wav);
    const audioSec = (fs.statSync(wav).size - 44) / 32_000;
    const t0 = performance.now();
    await transcribeWav(wav, { language: "en", ...opts });
    return audioSec / ((performance.now() - t0) / 1000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

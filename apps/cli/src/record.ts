import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { dataPaths, resolveDataDir, resolveFfmpeg } from "@rocky/core";
import { importCommand } from "./commands.ts";

/** `"Name" (audio)` lines from `ffmpeg -list_devices true -f dshow -i dummy`. */
export function parseDshowAudio(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s+\(audio\)/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** ffmpeg input arguments for a microphone on this OS. */
export function micInput(platform: NodeJS.Platform, device: string): string[] {
  if (platform === "win32") return ["-f", "dshow", "-i", `audio=${device}`];
  if (platform === "darwin") return ["-f", "avfoundation", "-i", `:${device}`];
  return ["-f", "pulse", "-i", device];
}

async function listMics(ffmpeg: string): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const stderr = await new Promise<string>((resolve) => {
    const p = spawn(
      ffmpeg,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      {
        windowsHide: true,
      },
    );
    let buf = "";
    p.stderr.on("data", (d: Buffer) => {
      buf += d.toString();
    });
    p.on("close", () => resolve(buf));
    p.on("error", () => resolve(""));
  });
  return parseDshowAudio(stderr);
}

/**
 * `rocky record`: records a microphone with the pinned ffmpeg until Ctrl+C (or --minutes), then
 * imports it as a lecture or meeting (transcribe and extract). Tab and system audio need the
 * browser's screen-share capture, so they stay in the web UI.
 */
export async function recordCommand(opts: {
  dataDir?: string | undefined;
  kind?: string;
  title?: string;
  consent?: boolean;
  device?: string;
  listDevices?: boolean;
  minutes?: string;
  wait?: boolean;
}): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const ffmpeg = await resolveFfmpeg(dir);
  if (!ffmpeg) {
    console.error("ffmpeg not found. Run `rocky doctor --fix` to install the pinned copy.");
    return 1;
  }
  const mics = await listMics(ffmpeg);
  if (opts.listDevices) {
    console.log(
      mics.length
        ? mics.map((m, i) => `${i + 1}. ${m}`).join("\n")
        : process.platform === "win32"
          ? "No microphones found."
          : "Device listing is Windows-only; pass --device (macOS: index like 0, Linux: a PulseAudio source or 'default').",
    );
    return 0;
  }
  if (!opts.consent) {
    console.error(
      "Recording needs --consent: you confirm everyone being recorded knows, and recording is lawful where you are.",
    );
    return 1;
  }

  let device = opts.device;
  if (!device && process.platform === "win32") {
    if (mics.length === 1) device = mics[0];
    else if (mics.length > 1 && process.stdin.isTTY) {
      console.log(mics.map((m, i) => `${i + 1}. ${m}`).join("\n"));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const pick = Number((await rl.question("Microphone number: ")).trim());
      rl.close();
      device = mics[pick - 1];
    } else if (mics.length > 1) {
      console.error(`Several microphones; pick one with --device:\n${mics.join("\n")}`);
      return 1;
    }
  }
  device ??= process.platform === "darwin" ? "0" : "default";
  if (!device) {
    console.error("No microphone selected.");
    return 1;
  }

  const recDir = path.join(dataPaths(dir).rec, "cli");
  fs.mkdirSync(recDir, { recursive: true });
  const out = path.join(recDir, `${randomUUID()}.wav`);
  const minutes = opts.minutes ? Number(opts.minutes) : undefined;
  if (minutes !== undefined && !(minutes > 0 && minutes <= 600)) {
    console.error("--minutes must be between 0 and 600.");
    return 1;
  }
  // 16 kHz mono PCM is what whisper wants; ~1.9 MB per minute.
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...micInput(process.platform, device),
    ...(minutes ? ["-t", String(Math.round(minutes * 60))] : []),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    out,
  ];
  console.log(
    `Recording "${device}"${minutes ? ` for ${minutes} min` : ""}. Press Ctrl+C to stop.`,
  );
  const started = Date.now();
  const code = await new Promise<number>((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    // Ctrl+C: ask ffmpeg to finish the file ("q"), rather than dying with a broken header.
    const stop = () => p.stdin.write("q");
    process.on("SIGINT", stop);
    p.on("close", (c) => {
      process.off("SIGINT", stop);
      if (c && err.trim()) console.error(err.trim());
      resolve(c ?? 0);
    });
    p.on("error", (e) => {
      console.error(e.message);
      resolve(1);
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
    console.error(
      `Nothing was recorded (ffmpeg exit ${code}). Check --device; see --list-devices.`,
    );
    fs.rmSync(out, { force: true });
    return 1;
  }
  console.log(`Recorded ${Math.floor(secs / 60)} min ${secs % 60} s. Importing…`);
  try {
    return await importCommand(out, {
      dataDir: opts.dataDir,
      kind: opts.kind === "meeting" ? "meeting" : "lecture",
      title:
        opts.title ??
        `${opts.kind === "meeting" ? "Meeting" : "Lecture"} ${new Date(started).toLocaleString()}`,
      wait: opts.wait,
    });
  } finally {
    // importMedia copied it into the blob store.
    fs.rmSync(out, { force: true });
  }
}

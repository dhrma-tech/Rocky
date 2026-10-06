import { execFile, spawn } from "node:child_process";

/** Runs a command, resolving stdout or null on any failure (missing binary, non-zero exit, timeout). */
export function tryExec(cmd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

export interface RunOptions {
  /** Called for every complete stderr line (whisper and ffmpeg report progress there). */
  onStderrLine?: (line: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  code: number | null;
  /** The last ~4 KB of stderr, for error messages. */
  stderrTail: string;
}

/** Spawns a long-running tool and streams its stderr lines. Never uses a shell. */
export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts?: RunOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    let tail = "";
    let partial = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      tail = (tail + d).slice(-4096);
      const lines = (partial + d).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) if (l) opts.onStderrLine?.(l);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (partial) opts.onStderrLine?.(partial);
      resolve({ code, stderrTail: tail });
    });
  });

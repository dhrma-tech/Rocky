import { execFile } from "node:child_process";

/** Runs a command, resolving stdout or null on any failure (missing binary, non-zero exit, timeout). */
export function tryExec(cmd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

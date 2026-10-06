import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dataPaths, resolveDataDir } from "@rocky/core";

/**
 * Autostart (PLAN §4.10). Windows: a per-user Run key, which needs no admin rights
 * (`schtasks /SC ONLOGON` does). Verified 2026-10-06: HKCU\…\Run runs at logon, command ≤ 260
 * chars. The Run entry starts `rocky daemon --background`, which respawns the daemon detached
 * with no console window and logs to <data>/logs/daemon.log. A console window may flash briefly
 * at logon before the respawn.
 */

const run = promisify(execFile);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "Rocky";
const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

export function autostartCommandLine(dataDir: string): string {
  return `"${process.execPath}" "${cliEntry}" --data-dir "${dataDir}" daemon --background`;
}

export async function daemonInstallCommand(opts: {
  dataDir?: string | undefined;
  uninstall?: boolean;
}): Promise<number> {
  if (process.platform !== "win32") {
    console.error(
      "Autostart is set up for Windows only in V1. On macOS use a launchd agent and on Linux a systemd user unit running:\n" +
        `  ${process.execPath} ${cliEntry} daemon`,
    );
    return 1;
  }
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  try {
    if (opts.uninstall) {
      await run("reg", ["delete", RUN_KEY, "/v", VALUE, "/f"], { windowsHide: true }).catch(
        () => null,
      );
      console.log(
        "Rocky will no longer start at sign-in. The running daemon (if any) keeps running.",
      );
      return 0;
    }
    const cmd = autostartCommandLine(dir);
    if (cmd.length > 260) {
      console.error(
        `The start command is ${cmd.length} characters; Windows allows 260. Move Rocky to a shorter path.`,
      );
      return 1;
    }
    await run("reg", ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", cmd, "/f"], {
      windowsHide: true,
    });
    console.log(`Rocky will start at sign-in:\n  ${cmd}\nUndo with: rocky daemon uninstall`);
    return 0;
  } catch (err) {
    console.error(
      `Could not update the Run key: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

/** Respawns the daemon detached and hidden, logging to a file; returns once it is started. */
export async function daemonBackground(opts: {
  dataDir?: string | undefined;
  port?: string;
}): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const info = path.join(dir, "daemon.json");
  if (fs.existsSync(info)) {
    const { port } = JSON.parse(fs.readFileSync(info, "utf8")) as { port: number };
    const up = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (up?.ok) {
      console.log(`The daemon is already running on 127.0.0.1:${port}.`);
      return 0;
    }
  }
  const logs = dataPaths(dir).logs;
  fs.mkdirSync(logs, { recursive: true });
  const out = fs.openSync(path.join(logs, "daemon.log"), "a");
  const child = spawn(
    process.execPath,
    [cliEntry, "--data-dir", dir, "daemon", ...(opts.port ? ["--port", opts.port] : [])],
    { detached: true, windowsHide: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  console.log(
    `Daemon started in the background (pid ${child.pid}); log: ${path.join(logs, "daemon.log")}`,
  );
  return 0;
}

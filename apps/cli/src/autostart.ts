import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dataPaths, resolveDataDir } from "@rocky/core";

/**
 * Autostart at sign-in (PLAN §4.10, roadmap I3), per user and without admin rights:
 * - Windows: a per-user Run key. Verified 2026-10-06: HKCU\…\Run runs at logon, command ≤ 260
 *   chars. It starts `rocky daemon --background`, which respawns the daemon hidden and logs to
 *   <data>/logs/daemon.log. A console window may flash briefly at logon before the respawn.
 * - macOS: a launchd agent in ~/Library/LaunchAgents (RunAtLoad, KeepAlive on crash).
 * - Linux: a systemd user unit in ~/.config/systemd/user (restart on failure).
 * The macOS and Linux paths are generated and unit-tested but not yet run on those systems
 * (docs/DECISIONS.md D-041). Catch-up after sleep is the daemon's job, not the service manager's.
 */

const run = promisify(execFile);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "Rocky";
const LABEL = "dev.rocky.daemon";
const UNIT = "rocky.service";
const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

export function autostartCommandLine(dataDir: string): string {
  return `"${process.execPath}" "${cliEntry}" --data-dir "${dataDir}" daemon --background`;
}

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );

/** The launchd agent: runs the daemon in the foreground so launchd can supervise it. */
export function launchdPlist(o: {
  node: string;
  cli: string;
  dataDir: string;
  log: string;
}): string {
  const args = [o.node, o.cli, "--data-dir", o.dataDir, "daemon"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/** systemd quotes: wrap in double quotes, escape backslashes, quotes and specifiers. */
const sdQuote = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The systemd user unit: started at login by default.target, restarted if it crashes. */
export function systemdUnit(o: { node: string; cli: string; dataDir: string }): string {
  return `[Unit]
Description=Rocky daemon (local-first memory and approval layer)
After=network-online.target

[Service]
ExecStart=${[o.node, o.cli, "--data-dir", o.dataDir, "daemon"].map(sdQuote).join(" ")}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const plistPath = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = () => path.join(os.homedir(), ".config", "systemd", "user", UNIT);

export interface AutostartStatus {
  installed: boolean;
  /** Where it lives: the Run key, the plist or the unit file. */
  where: string;
}

export async function autostartStatus(): Promise<AutostartStatus> {
  if (process.platform === "win32") {
    const out = await run("reg", ["query", RUN_KEY, "/v", VALUE], { windowsHide: true }).catch(
      () => null,
    );
    return { installed: Boolean(out?.stdout.includes(VALUE)), where: `${RUN_KEY}\\${VALUE}` };
  }
  const file = process.platform === "darwin" ? plistPath() : unitPath();
  return { installed: fs.existsSync(file), where: file };
}

/** Installs autostart for this user. Returns a sentence for the user, or throws with the cause. */
export async function installAutostart(dataDir: string): Promise<string> {
  const log = path.join(dataPaths(dataDir).logs, "daemon.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (process.platform === "win32") {
    const cmd = autostartCommandLine(dataDir);
    if (cmd.length > 260)
      throw new Error(
        `The start command is ${cmd.length} characters; Windows allows 260. Move Rocky to a shorter path.`,
      );
    await run("reg", ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", cmd, "/f"], {
      windowsHide: true,
    });
    return `Rocky will start at sign-in:\n  ${cmd}`;
  }
  const o = { node: process.execPath, cli: cliEntry, dataDir, log };
  if (process.platform === "darwin") {
    const file = plistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, launchdPlist(o));
    const uid = String(process.getuid?.() ?? "");
    // Reload if it was there before; bootstrap fails on an already-loaded label.
    await run("launchctl", ["bootout", `gui/${uid}`, file]).catch(() => null);
    await run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    return `Rocky will start at sign-in (launchd agent ${file}).`;
  }
  const file = unitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit(o));
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", UNIT]);
  return `Rocky will start at sign-in (systemd user unit ${file}). It keeps running only while you are signed in unless you run: loginctl enable-linger`;
}

export async function uninstallAutostart(): Promise<string> {
  if (process.platform === "win32") {
    await run("reg", ["delete", RUN_KEY, "/v", VALUE, "/f"], { windowsHide: true }).catch(
      () => null,
    );
  } else if (process.platform === "darwin") {
    const file = plistPath();
    await run("launchctl", ["bootout", `gui/${String(process.getuid?.() ?? "")}`, file]).catch(
      () => null,
    );
    fs.rmSync(file, { force: true });
  } else {
    await run("systemctl", ["--user", "disable", "--now", UNIT]).catch(() => null);
    fs.rmSync(unitPath(), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => null);
  }
  return "Rocky will no longer start at sign-in. A running daemon keeps running until you stop it.";
}

export async function daemonInstallCommand(opts: {
  dataDir?: string | undefined;
  uninstall?: boolean;
}): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  try {
    console.log(opts.uninstall ? await uninstallAutostart() : await installAutostart(dir));
    if (!opts.uninstall) console.log("Undo with: rocky daemon uninstall");
    return 0;
  } catch (err) {
    console.error(
      `Could not set up autostart: ${err instanceof Error ? err.message : String(err)}`,
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

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { cliInvocation, navigationTarget, parseOpenLink, permissionAllowed } from "./shell.ts";

/**
 * Rocky desktop (roadmap A1, D-050): a window around the local daemon. The daemon is the
 * always-on part; it runs on this app's own Node (ELECTRON_RUN_AS_NODE), keeps running when the
 * window closes, and starts at sign-in. The window only ever shows the daemon's own pages.
 */

// The installed app keeps the repo layout (apps/desktop beside apps/cli), so this holds in both.
const CLI = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
// The installed app ships config, samples, templates and the web UI in resources/home.
if (app.isPackaged) process.env.ROCKY_HOME = path.join(process.resourcesPath, "home");

/** Runs the Rocky CLI on this binary as Node and collects its output. */
function runCli(args: string[], opts: { inherit?: boolean } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  return new Promise<{ code: number; out: string }>((resolve) => {
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the daemon if it isn't running, then trades the install token for a one-time link. */
async function signInLink(): Promise<{ url: string; origin: string }> {
  const started = await runCli(["daemon", "--background"]);
  if (started.code !== 0) throw new Error(started.out.trim() || "The daemon didn't start.");
  let last = "";
  // A first start opens (and maybe encrypts) the store; give it up to a minute.
  for (let i = 0; i < 60; i++) {
    const r = await runCli(["open"]);
    const link = parseOpenLink(r.out);
    if (link) return link;
    last = r.out.trim();
    await sleep(1000);
  }
  throw new Error(last || "The daemon didn't answer.");
}

function harden(origin: string) {
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) =>
    done(permissionAllowed(permission, wc.getURL(), origin)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permissionAllowed(permission, requestingOrigin, origin),
  );
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (e, url) => {
      const t = navigationTarget(url, origin);
      if (t === "allow") return;
      e.preventDefault();
      if (t === "external") void shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (navigationTarget(url, origin) !== "block") void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
}

async function openWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    show: false,
    title: "Rocky",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  try {
    const link = await signInLink();
    harden(link.origin);
    await win.loadURL(link.url);
    // The installed app keeps the daemon starting at sign-in (roadmap I3, D-050); the entry
    // points at this binary, which re-runs it as the CLI. The uninstaller removes it.
    if (app.isPackaged && !process.env.ROCKY_DESKTOP_SMOKE) void runCli(["daemon", "install"]);
    // Smoke test (CI, release check): prove the window signs in and renders, then quit.
    const shot = process.env.ROCKY_DESKTOP_SMOKE;
    if (shot) {
      await sleep(3000);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(shot, (await win.webContents.capturePage()).toPNG());
      console.log(`smoke ok: ${win.webContents.getURL()} "${win.webContents.getTitle()}"`);
      app.quit();
    }
  } catch (err) {
    dialog.showErrorBox(
      "Rocky couldn't start",
      `${err instanceof Error ? err.message : String(err)}\n\nRun \`rocky doctor\` in a terminal for details.`,
    );
    app.quit();
  }
}

const cliArgs = cliInvocation(process.argv, CLI);
if (cliArgs) {
  // Started as `<Rocky> <cli entry> …` (autostart, the daemon's respawn): act as Node, no window.
  void runCli(cliArgs.slice(1), { inherit: true }).then((r) => app.exit(r.code));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null);
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else void openWindow();
  });
  // Closing the window ends the app; the daemon keeps running in the background.
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
  });
  void app.whenReady().then(openWindow);
}

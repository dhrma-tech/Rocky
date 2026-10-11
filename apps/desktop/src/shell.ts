import path from "node:path";

/**
 * Pure helpers for the desktop shell (roadmap A1, D-050). No Electron import here, so they are
 * unit-tested under plain Node.
 */

/** The sign-in link `rocky open` prints. */
const LINK = /http:\/\/127\.0\.0\.1:(\d+)\/auth\/bootstrap\?code=[A-Za-z0-9_-]+/;

export function parseOpenLink(stdout: string): { url: string; origin: string } | null {
  const m = LINK.exec(stdout);
  if (!m) return null;
  return { url: m[0], origin: `http://127.0.0.1:${m[1]}` };
}

/**
 * The app binary doubles as the Node runtime for the CLI: autostart entries and the daemon's own
 * respawn call `<Rocky> <cli entry> …`. When the CLI entry is among the arguments, the shell
 * re-runs them as Node instead of opening a window. Returns the CLI arguments, or null.
 */
export function cliInvocation(argv: readonly string[], cliEntry: string): string[] | null {
  const want = path.resolve(cliEntry).toLowerCase();
  const i = argv.findIndex((a, n) => n > 0 && path.resolve(a).toLowerCase() === want);
  return i < 0 ? null : argv.slice(i);
}

/** Only the daemon's own pages load in the window; everything else opens in the browser. */
export function navigationTarget(url: string, origin: string): "allow" | "external" | "block" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "block";
  }
  if (u.origin === origin) return "allow";
  if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:")
    return "external";
  return "block";
}

/** Permissions the UI may ask for: the microphone for meeting capture, and clipboard writes. */
const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-sanitized-write"]);

export function permissionAllowed(permission: string, requestingUrl: string, origin: string) {
  return ALLOWED_PERMISSIONS.has(permission) && navigationTarget(requestingUrl, origin) === "allow";
}

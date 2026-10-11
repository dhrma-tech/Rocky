// Desktop shell helpers (roadmap A1, D-050): the window shows only the daemon's pages.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliInvocation, navigationTarget, parseOpenLink, permissionAllowed } from "../src/shell.ts";

const ORIGIN = "http://127.0.0.1:7337";

describe("parseOpenLink", () => {
  it("finds the one-time link in `rocky open` output", () => {
    const out =
      "Open this link within 60 seconds (single use):\nhttp://127.0.0.1:7400/auth/bootstrap?code=ab_C-12\n";
    expect(parseOpenLink(out)).toEqual({
      url: "http://127.0.0.1:7400/auth/bootstrap?code=ab_C-12",
      origin: "http://127.0.0.1:7400",
    });
  });
  it("returns null when the daemon isn't up", () => {
    expect(parseOpenLink("The daemon is not running. Start it with `rocky daemon`.")).toBeNull();
  });
});

describe("cliInvocation", () => {
  const cli = path.resolve("apps/cli/src/index.ts");
  it("treats `<Rocky> <cli entry> …` as a CLI run (autostart, the daemon's respawn)", () => {
    expect(cliInvocation(["Rocky.exe", cli, "daemon", "--background"], cli)).toEqual([
      cli,
      "daemon",
      "--background",
    ]);
  });
  it("is not fooled by a plain launch or `electron .`", () => {
    expect(cliInvocation(["Rocky.exe"], cli)).toBeNull();
    expect(cliInvocation(["electron.exe", "."], cli)).toBeNull();
  });
});

describe("navigation", () => {
  it("keeps the daemon's pages in the window and sends web links to the browser", () => {
    expect(navigationTarget(`${ORIGIN}/approvals`, ORIGIN)).toBe("allow");
    expect(navigationTarget("https://github.com/dhrma-tech/Rocky", ORIGIN)).toBe("external");
    expect(navigationTarget("mailto:a@b.c", ORIGIN)).toBe("external");
  });
  it("blocks other local ports, files and script URLs", () => {
    expect(navigationTarget("http://127.0.0.1:9999/", ORIGIN)).toBe("external");
    expect(navigationTarget("file:///C:/Windows/win.ini", ORIGIN)).toBe("block");
    expect(navigationTarget("javascript:alert(1)", ORIGIN)).toBe("block");
    expect(navigationTarget("not a url", ORIGIN)).toBe("block");
  });
});

describe("permissions", () => {
  it("allows the microphone only for the daemon's own pages", () => {
    expect(permissionAllowed("media", `${ORIGIN}/meetings`, ORIGIN)).toBe(true);
    expect(permissionAllowed("media", "https://evil.example/", ORIGIN)).toBe(false);
  });
  it("denies everything else", () => {
    for (const p of ["geolocation", "notifications", "openExternal", "midi", "hid"])
      expect(permissionAllowed(p, `${ORIGIN}/`, ORIGIN)).toBe(false);
  });
});

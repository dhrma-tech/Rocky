// Roadmap I3: the service files Rocky writes on macOS and Linux (not runnable on this CI's Windows
// leg, so their content is what is tested; docs/DECISIONS.md D-041).
import { describe, expect, it } from "vitest";
import { launchdPlist, systemdUnit } from "../src/autostart.ts";
import { autostartCheck } from "../src/doctor.ts";

const o = {
  node: "/usr/local/bin/node",
  cli: "/opt/rocky/apps/cli/src/index.ts",
  dataDir: "/Users/sam/Rocky & Co",
  log: "/Users/sam/Rocky & Co/logs/daemon.log",
};

describe("service files", () => {
  it("launchd: runs the daemon at load, restarts it after a crash, escapes paths", () => {
    const p = launchdPlist(o);
    expect(p).toContain("<string>dev.rocky.daemon</string>");
    expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(p).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(p).toContain("<string>/Users/sam/Rocky &amp; Co</string>");
    expect(p).not.toContain("Rocky & Co<");
    expect(p).toMatch(/<string>daemon<\/string>\n {2}<\/array>/);
  });

  it("systemd: quotes every argument and starts with the user session", () => {
    const u = systemdUnit({ ...o, dataDir: '/home/sam/my "data" 100%' });
    expect(u).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/rocky/apps/cli/src/index.ts" "--data-dir" "/home/sam/my \\"data\\" 100%%" "daemon"',
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
  });
});

describe("doctor", () => {
  it("warns, never fails, when autostart is missing", () => {
    expect(autostartCheck({ installed: false, where: "x" })).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("--fix"),
    });
    expect(autostartCheck({ installed: true, where: "HKCURunRocky" })).toMatchObject({
      status: "pass",
    });
  });
});

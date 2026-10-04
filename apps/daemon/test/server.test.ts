import fs from "node:fs";
import { memorySecrets } from "@rocky/core";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../packages/core/test/helpers.ts";
import { HW_HIGH } from "../../../packages/core/test/router-helpers.ts";
import { daemonInfoFile, startDaemon } from "../src/index.ts";

describe("startDaemon", () => {
  it("binds 127.0.0.1 only, creates the install token, and records its port", async () => {
    const dir = tempDir();
    const secrets = memorySecrets();
    const d = await startDaemon({
      dataDir: dir,
      port: 47_000 + Math.floor(Math.random() * 1000),
      log: () => {},
      runtime: {
        secrets,
        hardware: { ...HW_HIGH, platform: "win32", release: "x", cpu: "x", cores: 4 },
      },
    });
    try {
      expect(secrets.get("daemon-token")).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(fs.readFileSync(daemonInfoFile(dir), "utf8")).port).toBe(d.port);
      const res = await fetch(`${d.url}/api/v1/health`);
      expect(res.status).toBe(200);
      expect(d.host).toBe("127.0.0.1");
      expect((await fetch(`${d.url}/api/v1/settings`)).status).toBe(401);
      const ok = await fetch(`${d.url}/api/v1/settings`, {
        headers: { authorization: `Bearer ${secrets.get("daemon-token")}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await d.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(fs.existsSync(daemonInfoFile(dir))).toBe(false);
  });
});

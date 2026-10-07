// SECURITY.md claims that had no direct test before Phase 9.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Connector } from "@rocky/connector-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ActionRegistry,
  ConnectorRegistry,
  ConnectorService,
  memorySecrets,
  migrate,
  openDb,
  redact,
  redactingLogger,
} from "../../src/index.ts";
import { tempDir } from "../helpers.ts";

const repo = path.resolve(import.meta.dirname, "../../../..");

describe("Secrets: redaction covers every documented token pattern", () => {
  // One realistic-looking sample per pattern SECURITY.md lists.
  const samples = {
    "sk-ant-": "sk-ant-api03-Abc123def456ghi789",
    "xoxb-": "xoxb-1234567890-abcdefghij",
    "xoxp-": "xoxp-1234567890-abcdefghij",
    "xapp-": "xapp-1-A0123456789-abcdef",
    ghp_: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    github_pat_: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    lin_api_: "lin_api_abcdefghijklmnopqrstuvwxyz",
    phx_: "phx_abcdefghijklmnopqrstuvwxyz0123",
    Bearer: "Bearer abc.def.ghi-jkl_mno",
  };
  it.each(Object.entries(samples))("redacts %s", (_label, token) => {
    const out = redact(`request failed with ${token} attached`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(token.replace(/^Bearer /, ""));
  });
});

describe("Secrets: never in the database or the logs", () => {
  it("a connector token set through the service is not in the DB file, and a logged one is redacted", async () => {
    const dir = tempDir();
    const file = path.join(dir, "rocky.db");
    const db = openDb(file);
    migrate(db);
    const token = "ghp_SECRETsecretSECRETsecret0123456789";
    const logs: string[] = [];
    const leaky: Connector<Record<string, never>, null> = {
      id: "leaky",
      displayName: "Leaky",
      permissions: "Reads",
      configSchema: z.object({}),
      secrets: [{ name: "token", label: "token" }],
      defaultIntervalMin: 15,
      async *sync(ctx) {
        // A careless connector logs its own token; the logger must still redact it.
        ctx.log(`calling the API with ${ctx.secrets.get("token")}`);
        yield { documents: [], cursor: null };
      },
      async health() {
        return { status: "ok", message: "" };
      },
    };
    const registry = new ConnectorRegistry();
    registry.register(leaky);
    const secrets = memorySecrets();
    const svc = new ConnectorService({
      db,
      secrets,
      registry,
      actions: new ActionRegistry(),
      blobsDir: path.join(dir, "blobs"),
      log: redactingLogger((m) => logs.push(m)),
    });
    svc.add("leaky", {});
    svc.setSecret("leaky", "token", token);
    await svc.sync("leaky");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    expect(logs.join("\n")).toContain("calling the API with [redacted]");
    expect(logs.join("\n")).not.toContain(token);
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("rocky.db")))
      expect(fs.readFileSync(path.join(dir, f)).includes(token), f).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe(".gitignore", () => {
  const ignored = (p: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  };
  it.each([
    ".env",
    ".env.local",
    "apps/daemon/.env.production",
    "RockyData/rocky.db",
    "data/x.json",
    "rocky.db",
    "rocky.db-wal",
    "evals/private/questions.yaml",
    "models/ggml-small.bin",
  ])("ignores %s", (p) => {
    expect(ignored(p)).toBe(true);
  });
  it("still tracks the example env file and the public eval set", () => {
    expect(ignored(".env.example")).toBe(false);
    expect(ignored("evals/public/questions.yaml")).toBe(false);
  });
  it("never ignores test fixtures (a data/ folder inside one once went missing in CI)", () => {
    expect(ignored("packages/importers/test/fixtures/x/data/tweets.js")).toBe(false);
    const missed: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.includes(`${path.sep}fixtures${path.sep}`)) {
          const rel = path.relative(repo, full).split(path.sep).join("/");
          if (ignored(rel)) missed.push(rel);
        }
      }
    };
    for (const top of ["packages", "apps"]) walk(path.join(repo, top));
    expect(missed).toEqual([]);
  });
});

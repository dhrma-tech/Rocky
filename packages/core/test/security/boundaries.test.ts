// CLAUDE.md boundaries: core never imports concrete connectors; connectors get no store handle.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgs = path.resolve(import.meta.dirname, "../../..");

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) yield full;
  }
}

/** Source without comments, so a doc comment naming a forbidden symbol is not a violation. */
const code = (f: string) =>
  fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

const offenders = (root: string, re: RegExp) =>
  [...files(root)].filter((f) => re.test(code(f))).map((f) => path.relative(pkgs, f));

describe("package boundaries", () => {
  it("core never imports concrete connectors", () => {
    expect(
      offenders(
        path.join(pkgs, "core/src"),
        /from\s+["']@rocky\/connectors["']|packages\/connectors\//,
      ),
    ).toEqual([]);
  });

  it("core never imports the MCP server or the archive importers", () => {
    expect(
      offenders(path.join(pkgs, "core/src"), /from\s+["']@rocky\/(mcp|importers)["']/),
    ).toEqual([]);
  });

  it("the MCP server is read-only: no actions, executors, connectors, deletion or writes", () => {
    const root = path.join(pkgs, "mcp/src");
    expect(
      offenders(
        root,
        /\b(ActionService|actions\.(propose|approve|execute)|registry|deleteData|upsertDocument|connectors\.|appendAudit)\b|@rocky\/connectors|@rocky\/connector-sdk/,
      ),
    ).toEqual([]);
    // Every SQL statement it runs is a SELECT.
    for (const f of files(root)) {
      const sql = fs.readFileSync(f, "utf8").match(/\.prepare\(\s*[`"']([\s\S]*?)[`"']/g) ?? [];
      for (const s of sql)
        expect(s, path.relative(pkgs, f)).toMatch(/prepare\(\s*[`"']\s*select\b/i);
    }
  });

  it("importers only parse: no store, no network", () => {
    expect(
      offenders(
        path.join(pkgs, "importers/src"),
        /from\s+["']@rocky\/core["']|packages\/core\/|\bfetch\(|node:https?["']/,
      ),
    ).toEqual([]);
  });

  it("connectors and the SDK never import the core (no store, no executors)", () => {
    for (const root of ["connectors/src", "connector-sdk/src"])
      expect(
        offenders(path.join(pkgs, root), /from\s+["']@rocky\/core["']|packages\/core\//),
      ).toEqual([]);
  });

  // Roadmap I1: only the connector host handles OAuth tokens and connector-scoped secrets.
  it("token refresh, browser sign-in and the connector keychain view live only in the connector host", () => {
    const allowed = new Set([
      path.join("core", "src", "connectors", "host.ts"),
      path.join("core", "src", "secrets", "keychain.ts"),
      path.join("core", "src", "index.ts"),
      path.join("connector-sdk", "src", "oauth.ts"),
      path.join("connector-sdk", "src", "index.ts"),
    ]);
    const apps = path.resolve(pkgs, "../apps");
    const hits = [
      ...offenders(pkgs, /\b(refreshAccessToken|startLoopbackAuth|connectorOnlySecrets)\b/),
      ...[...files(apps)]
        .filter((f) =>
          /\b(refreshAccessToken|startLoopbackAuth|connectorOnlySecrets)\b/.test(code(f)),
        )
        .map((f) => path.relative(pkgs, f)),
    ].filter((f) => !allowed.has(f) && !f.includes(`${path.sep}test${path.sep}`));
    expect(hits).toEqual([path.join("..", "apps", "daemon", "src", "connector-host.ts")]);
  });
});

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

const offenders = (root: string, re: RegExp) =>
  [...files(root)]
    .filter((f) => re.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(pkgs, f));

describe("package boundaries", () => {
  it("core never imports concrete connectors", () => {
    expect(
      offenders(
        path.join(pkgs, "core/src"),
        /from\s+["']@rocky\/connectors["']|packages\/connectors\//,
      ),
    ).toEqual([]);
  });

  it("connectors and the SDK never import the core (no store, no executors)", () => {
    for (const root of ["connectors/src", "connector-sdk/src"])
      expect(
        offenders(path.join(pkgs, root), /from\s+["']@rocky\/core["']|packages\/core\//),
      ).toEqual([]);
  });
});

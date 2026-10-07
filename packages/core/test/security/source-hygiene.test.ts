// Invisible and bidirectional control characters in source change what code does without
// changing how it looks (Trojan Source, CVE-2021-42574). Write them as \u escapes instead.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../../..");
const SCAN = ["apps", "packages", "scripts", "config", "templates", "docs", "evals"];
const SKIP_DIRS = new Set(["node_modules", "dist", "fixtures", "corpus", ".vite"]);
const TEXT = /\.(ts|tsx|mts|js|mjs|json|ya?ml|md|css|html|sql)$/;

/** Zero-width, bidi embedding/override/isolate, BOM and soft hyphen. */
const FORBIDDEN = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff, 0x00ad,
]);

function* files(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (TEXT.test(e.name)) yield full;
  }
}

describe("source hygiene", () => {
  it("has no invisible or bidi control characters outside test fixtures", () => {
    const hits: string[] = [];
    for (const top of SCAN)
      for (const f of files(path.join(root, top))) {
        const lines = fs.readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          for (const ch of line) {
            const cp = ch.codePointAt(0) ?? 0;
            if (FORBIDDEN.has(cp))
              hits.push(`${path.relative(root, f)}:${i + 1} U+${cp.toString(16).toUpperCase()}`);
          }
        });
      }
    expect(hits).toEqual([]);
  });
});

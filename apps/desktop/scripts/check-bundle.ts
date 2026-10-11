// Release check (roadmap A1): the packed app runs Rocky's CLI on its own Node, and the native
// pieces load (SQLite with FTS5, sqlite-vec). Run after `pnpm dist` on each OS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "..", "dist");
const unpacked = fs.readdirSync(dist).find((d) => /-unpacked$|^mac/.test(d));
if (!unpacked) throw new Error(`no unpacked app in ${dist}`);
const out = path.join(dist, unpacked);
const mac = fs.readdirSync(out).find((d) => d.endsWith(".app"));
const [binary, resources] = mac
  ? [
      path.join(out, mac, "Contents", "MacOS", "Rocky"),
      path.join(out, mac, "Contents", "Resources"),
    ]
  : process.platform === "win32"
    ? [path.join(out, "Rocky.exe"), path.join(out, "resources")]
    : [path.join(out, "rocky"), path.join(out, "resources")];

const data = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-bundle-"));
let stdout = "";
try {
  stdout = execFileSync(
    binary,
    [path.join(resources, "app", "apps", "cli", "src", "index.ts"), "doctor", "--json"],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ROCKY_HOME: path.join(resources, "home"),
        ROCKY_DATA_DIR: data,
      },
      encoding: "utf8",
    },
  );
} catch (err) {
  // doctor exits 1 when an optional tool is missing on the runner; the report still prints.
  stdout = String((err as { stdout?: string }).stdout ?? "");
}
const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
  checks: { id: string; status: string; detail: string }[];
};
for (const id of ["node", "sqlite-vec", "fts5"]) {
  const c = report.checks.find((x) => x.id === id);
  if (c?.status !== "pass") throw new Error(`${id}: ${c?.status ?? "missing"} ${c?.detail ?? ""}`);
  console.log(`ok ${id}: ${c.detail}`);
}

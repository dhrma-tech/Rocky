// Builds the desktop installer for this OS (roadmap A1, D-050): stage, pack the Electron app,
// copy the staged app (with node_modules) into its resources, then make the installer from that
// prepackaged folder. electron-builder can't copy node_modules itself without re-collecting them
// (which would put Rocky's .ts packages under node_modules, where Node won't strip types).
// `--dir` stops after the unpacked app (for a quick local check).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const stage = path.join(desktop, "stage");
const dist = path.join(desktop, "dist");
const builder = (args: string) =>
  execSync(
    `pnpm exec electron-builder --projectDir stage --config ../electron-builder.yml ${args}`,
    {
      cwd: desktop,
      stdio: "inherit",
    },
  );

execSync("node scripts/stage.ts", { cwd: desktop, stdio: "inherit" });
fs.rmSync(dist, { recursive: true, force: true });
builder("--dir");

const unpacked = fs.readdirSync(dist).find((d) => /-unpacked$|^mac/.test(d));
if (!unpacked) throw new Error(`no unpacked app in ${dist}`);
const out = path.join(dist, unpacked);
const app = fs.readdirSync(out).find((d) => d.endsWith(".app"));
const resources = app ? path.join(out, app, "Contents", "Resources") : path.join(out, "resources");
fs.cpSync(path.join(stage, "app"), path.join(resources, "app"), { recursive: true });
console.log(`app copied into ${resources}`);

if (!process.argv.includes("--dir")) builder(`--prepackaged "${app ? path.join(out, app) : out}"`);

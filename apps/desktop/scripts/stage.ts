// Stages the desktop app for electron-builder (roadmap A1, D-050):
//   stage/app   Rocky's packages at their repo paths (apps/desktop, apps/cli, packages/core, …)
//               and the production third-party node_modules, flat
//   stage/home  what Rocky ships beside its code: config, samples, templates, the built web UI
// Node won't strip TypeScript under node_modules, so Rocky's own .ts sources stay outside it;
// node_modules/@rocky/<name> holds only a tiny JS stub that re-exports the real entry.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..", "..");
const stage = path.join(desktop, "stage");
const app = path.join(stage, "app");
const deployed = path.join(stage, "deploy");
const run = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "inherit" });
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;

fs.rmSync(stage, { recursive: true, force: true });
run("pnpm --filter @rocky/web build");
// Production dependencies of the desktop app, flat, with workspace packages copied in.
run(
  `pnpm --filter @rocky/desktop deploy --prod --legacy --config.node-linker=hoisted "${deployed}"`,
);

// Where each workspace package lives in the repo, by name.
const workspace = new Map<string, string>();
for (const group of ["apps", "packages"])
  for (const dir of fs.readdirSync(path.join(repo, group))) {
    const pj = path.join(repo, group, dir, "package.json");
    if (fs.existsSync(pj)) workspace.set(String(readJson(pj).name), path.join(group, dir));
  }

const skip = (src: string) => !/[\\/](test|e2e|node_modules)([\\/]|$)/.test(src);
fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
for (const entry of fs.readdirSync(path.join(deployed, "node_modules"))) {
  if (entry === "@rocky" || entry === ".bin") continue;
  fs.cpSync(path.join(deployed, "node_modules", entry), path.join(app, "node_modules", entry), {
    recursive: true,
  });
}
for (const f of ["src", "package.json"])
  fs.cpSync(path.join(repo, "apps", "desktop", f), path.join(app, "apps", "desktop", f), {
    recursive: true,
  });

for (const name of fs.readdirSync(path.join(deployed, "node_modules", "@rocky"))) {
  const full = `@rocky/${name}`;
  const rel = workspace.get(full);
  if (!rel) throw new Error(`${full} is not a workspace package`);
  fs.cpSync(path.join(repo, rel), path.join(app, rel), { recursive: true, filter: skip });
  // Dependencies pnpm could not hoist sit beside the package; keep them there.
  const nested = path.join(deployed, "node_modules", "@rocky", name, "node_modules");
  if (fs.existsSync(nested))
    fs.cpSync(nested, path.join(app, rel, "node_modules"), { recursive: true });
  // The stub: same exports, each a one-line re-export of the real .ts file.
  const pj = readJson(path.join(repo, rel, "package.json"));
  const stubDir = path.join(app, "node_modules", "@rocky", name);
  fs.mkdirSync(stubDir, { recursive: true });
  const exportsMap: Record<string, string> = {};
  const targets = (pj.exports ?? {}) as Record<string, string>;
  for (const [key, target] of Object.entries(targets)) {
    if (!target.endsWith(".ts")) continue;
    const file = `${key === "." ? "index" : key.replace(/^\.\//, "").replace(/\//g, "_")}.js`;
    const real = path.relative(stubDir, path.join(app, rel, target)).replace(/\\/g, "/");
    fs.writeFileSync(path.join(stubDir, file), `export * from "${real}";\n`);
    exportsMap[key] = `./${file}`;
  }
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    `${JSON.stringify({ name: full, type: "module", exports: exportsMap }, null, 2)}\n`,
  );
}

// Each OS builds its own installer: keep only this platform's SQLite prebuild, and drop the C
// sources the prebuilds were made from (about 45 MB).
for (const pkg of ["better-sqlite3", "better-sqlite3-multiple-ciphers"]) {
  const dir = path.join(app, "node_modules", pkg);
  for (const sub of ["deps", "src", "binding.gyp"])
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  const prebuilds = path.join(dir, "prebuilds");
  // Linux picks the glibc or musl build at run time; keep both there.
  const keep = new Set([
    `${process.platform}-${process.arch}.node`,
    `linuxmusl-${process.arch}.node`,
  ]);
  if (fs.existsSync(path.join(prebuilds, `${process.platform}-${process.arch}.node`)))
    for (const f of fs.readdirSync(prebuilds))
      if (!keep.has(f) || (process.platform !== "linux" && f.startsWith("linuxmusl")))
        fs.rmSync(path.join(prebuilds, f));
}

const desktopPkg = readJson(path.join(repo, "apps", "desktop", "package.json"));
const rootPkg = readJson(path.join(repo, "package.json"));
fs.writeFileSync(
  path.join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "rocky",
      productName: "Rocky",
      version: (process.env.ROCKY_VERSION ?? String(desktopPkg.version)).replace(/^v/, ""),
      description: "Local-first memory and approval layer",
      author: "Rocky contributors",
      license: rootPkg.license,
      type: "module",
      main: "apps/desktop/src/main.ts",
    },
    null,
    2,
  )}\n`,
);
// electron-builder packs only this package.json (see electron-builder.yml); same contents.
fs.mkdirSync(path.join(stage, "shell"), { recursive: true });
fs.copyFileSync(path.join(app, "package.json"), path.join(stage, "shell", "package.json"));
fs.copyFileSync(path.join(app, "package.json"), path.join(stage, "package.json"));
fs.copyFileSync(path.join(desktop, "installer.nsh"), path.join(stage, "installer.nsh"));
// The entry file must exist for electron-builder; the desktop sources need only Electron and Node.
fs.cpSync(
  path.join(app, "apps", "desktop", "src"),
  path.join(stage, "shell", "apps", "desktop", "src"),
  {
    recursive: true,
  },
);
fs.rmSync(deployed, { recursive: true, force: true });

const copy = (from: string, to: string) =>
  fs.cpSync(path.join(repo, from), path.join(stage, "home", to), { recursive: true });
copy("config", "config");
copy("samples/workspace", "samples/workspace");
copy("templates", "templates");
copy("apps/web/dist", "web");
console.log(`staged in ${stage}`);

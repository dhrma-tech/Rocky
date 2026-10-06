import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Connector, SDK_MAJOR } from "./types.ts";

/**
 * Plugin loader (connectors.md "Plugins"): `config.plugins` lists npm package names or file: URLs.
 * The default export is a Connector or Connector[]; package.json declares `rocky: { sdk: "^1" }`.
 * Plugins run in-process with the daemon's privileges (SECURITY.md); this is not a sandbox.
 */

export interface PluginResult {
  spec: string;
  connectors: Connector[];
  error?: string;
}

const looksLikeConnector = (x: unknown): x is Connector =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Connector).id === "string" &&
  /^[a-z0-9-]{2,40}$/.test((x as Connector).id) &&
  typeof (x as Connector).sync === "function" &&
  typeof (x as Connector).health === "function" &&
  typeof (x as Connector).configSchema?.safeParse === "function";

/** Reads `rocky.sdk` from the plugin's package.json and checks the major version. */
export function checkSdkRange(pkg: { rocky?: { sdk?: string } }, major = SDK_MAJOR): string | null {
  const range = pkg.rocky?.sdk;
  if (!range) return 'package.json has no "rocky": { "sdk": "^1" } field';
  const m = /^\^?~?(\d+)/.exec(range.trim());
  if (!m || Number(m[1]) !== major)
    return `needs connector SDK ${range}, this Rocky provides ${major}.x`;
  return null;
}

function findPackageJson(entry: string): string | null {
  let dir = fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export async function loadPlugins(
  specs: string[],
  opts: { resolveFrom?: string; importer?: (url: string) => Promise<unknown> } = {},
): Promise<PluginResult[]> {
  const importer = opts.importer ?? ((u: string) => import(u));
  const out: PluginResult[] = [];
  for (const spec of specs) {
    try {
      let url: string;
      let pkgFile: string | null;
      if (spec.startsWith("file:")) {
        const p = fileURLToPath(spec);
        const entry = fs.statSync(p).isDirectory()
          ? path.join(
              p,
              (
                JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")) as {
                  main?: string;
                }
              ).main ?? "index.js",
            )
          : p;
        url = pathToFileURL(entry).href;
        pkgFile = findPackageJson(p);
      } else {
        const resolved = import.meta.resolve(
          spec,
          opts.resolveFrom ? pathToFileURL(opts.resolveFrom).href : undefined,
        );
        url = resolved;
        pkgFile = findPackageJson(fileURLToPath(resolved));
      }
      if (!pkgFile) throw new Error("package.json not found");
      const bad = checkSdkRange(JSON.parse(fs.readFileSync(pkgFile, "utf8")));
      if (bad) throw new Error(bad);
      const mod = (await importer(url)) as { default?: unknown };
      const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
      if (!exported.length || !exported.every(looksLikeConnector))
        throw new Error(
          "default export must be a Connector or Connector[] (id, sync, health, configSchema)",
        );
      out.push({ spec, connectors: exported as Connector[] });
    } catch (err) {
      out.push({ spec, connectors: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export { looksLikeConnector };

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepMerge, loadAppConfig, loadLayeredYaml, resolveDataDir } from "../src/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-cfg-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveDataDir", () => {
  const appData = () => path.join(tmp, "appdata");

  it("prefers the flag over everything", () => {
    const r = resolveDataDir({ flag: path.join(tmp, "f"), env: { ROCKY_DATA_DIR: "x" } });
    expect(r).toEqual({ dir: path.join(tmp, "f"), source: "flag" });
  });

  it("uses ROCKY_DATA_DIR over the location file", () => {
    const r = resolveDataDir({
      env: { ROCKY_DATA_DIR: path.join(tmp, "e"), APPDATA: appData() },
      platform: "win32",
    });
    expect(r.source).toBe("env");
  });

  it("follows location.yaml when present", () => {
    fs.mkdirSync(path.join(appData(), "Rocky"), { recursive: true });
    fs.writeFileSync(
      path.join(appData(), "Rocky", "location.yaml"),
      `dataDir: ${JSON.stringify(path.join(tmp, "loc"))}\n`,
    );
    const r = resolveDataDir({ env: { APPDATA: appData() }, platform: "win32" });
    expect(r).toEqual({ dir: path.join(tmp, "loc"), source: "location-file" });
  });

  it("rejects a malformed location.yaml", () => {
    fs.mkdirSync(path.join(appData(), "Rocky"), { recursive: true });
    fs.writeFileSync(path.join(appData(), "Rocky", "location.yaml"), "nope: 1\n");
    expect(() => resolveDataDir({ env: { APPDATA: appData() }, platform: "win32" })).toThrow();
  });

  it("falls back to %APPDATA%Rocky", () => {
    const r = resolveDataDir({ env: { APPDATA: appData() }, platform: "win32" });
    expect(r).toEqual({ dir: path.join(appData(), "Rocky"), source: "default" });
  });
});

describe("loadAppConfig", () => {
  it("returns defaults when rocky.yaml is missing", () => {
    const c = loadAppConfig(tmp);
    expect(c.localOnly).toBe(false);
    expect(c.budget.monthlyCapUsd).toBe(10);
    expect(c.ollama.baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("validates user values", () => {
    fs.writeFileSync(
      path.join(tmp, "rocky.yaml"),
      "localOnly: true\nbudget: { monthlyCapUsd: -1 }\n",
    );
    expect(() => loadAppConfig(tmp)).toThrow();
  });
});

describe("layered yaml", () => {
  it("deep merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({
      a: { b: 1, c: [2], d: 3 },
    });
  });

  it("merges the user override over the repo base", () => {
    const base = path.join(tmp, "base");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "p.yaml"), "models: { a: x, b: y }\n");
    fs.mkdirSync(path.join(tmp, "config"));
    fs.writeFileSync(path.join(tmp, "config", "p.yaml"), "models: { b: z }\n");
    expect(loadLayeredYaml("p", tmp, base)).toEqual({ models: { a: "x", b: "z" } });
  });
});

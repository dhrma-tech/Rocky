import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtinConnectors } from "../src/index.ts";

/** Rules every built-in connector must meet to load in the daemon (keychain names, catalog). */
describe("built-in connector catalog", () => {
  it("registers all 12 connectors of PLAN.md, with unique, keychain-safe ids", () => {
    const ids = builtinConnectors.map((c) => c.id);
    expect(ids).toEqual([
      "github",
      "notion",
      "gmail",
      "gcal",
      "gdrive",
      "linear",
      "todoist",
      "slack",
      "caldav",
      "asana",
      "posthog",
      "notion-calendar",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });

  it("secret names fit the keychain naming rule", () => {
    for (const c of builtinConnectors)
      for (const s of c.secrets)
        expect(`${c.id}:${s.name}`).toMatch(/^[^:]+:[a-z0-9][a-z0-9_-]{0,39}$/);
  });

  it("action types are namespaced by connector, and config schemas convert for the UI", () => {
    const prefixes: Record<string, string> = {
      gmail: "gmail",
      gcal: "gcal",
      gdrive: "gdrive",
      caldav: "caldav",
    };
    for (const c of builtinConnectors) {
      for (const a of c.actions?.() ?? [])
        expect(a.type.split(".")[0]).toBe(prefixes[c.id] ?? c.id);
      expect(() =>
        z.toJSONSchema(c.configSchema as z.ZodType, { unrepresentable: "any" }),
      ).not.toThrow();
      expect(c.permissions.length).toBeGreaterThan(10);
    }
  });
});

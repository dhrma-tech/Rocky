// Roadmap I1 + M3: every built-in connector declares the hosts it may reach and an honest tier.
import { describe, expect, it } from "vitest";
import { builtinConnectors } from "../src/index.ts";

describe("built-in connector manifests", () => {
  it.each(builtinConnectors.map((c) => [c.id, c] as const))(
    "%s declares egress and a tier",
    (_id, c) => {
      expect(typeof c.egress).toBe("function");
      expect(c.tier).toMatch(/^(experimental|link-only)$/);
    },
  );

  // D-021: nothing is "supported" until its nightly live test passes.
  it("labels none of them supported yet; the link-only one has no network", () => {
    expect(builtinConnectors.filter((c) => c.tier === "supported")).toEqual([]);
    const linkOnly = builtinConnectors.filter((c) => c.tier === "link-only");
    expect(linkOnly.map((c) => c.id)).toEqual(["notion-calendar"]);
    expect(linkOnly[0]?.egress?.({} as never)).toEqual([]);
  });

  it("config-driven hosts come from the user's config", () => {
    const caldav = builtinConnectors.find((c) => c.id === "caldav");
    expect(caldav?.egress?.({ serverUrl: "https://dav.example.org/x" } as never)).toEqual([
      "https://dav.example.org/x",
      "*.example.org",
    ]);
    // iCloud hands out calendar homes on pNN-caldav.icloud.com.
    expect(caldav?.egress?.({ serverUrl: "https://caldav.icloud.com/" } as never)).toContain(
      "*.icloud.com",
    );
    expect(caldav?.egress?.({ serverUrl: "https://example.org/" } as never)).toEqual([
      "https://example.org/",
    ]);
  });
});

// UI spec "Design language and tokens": the generated stylesheet is current, both themes define
// the same tokens, and every contrast figure the spec states holds (computed, WCAG 2.x).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, renderCss, tokens } from "../src/index.ts";

const L = tokens.semantic.light;
const D = tokens.semantic.dark;

describe("tokens.css", () => {
  it("matches tokens.json (run `pnpm tokens` after editing the JSON)", () => {
    const committed = fs.readFileSync(path.join(import.meta.dirname, "../src/tokens.css"), "utf8");
    expect(committed).toBe(renderCss());
  });

  it("defines the same semantic tokens in light and dark", () => {
    expect(Object.keys(D).sort()).toEqual(Object.keys(L).sort());
  });

  it("uses the spec's token names", () => {
    const css = renderCss();
    for (const name of [
      "--color-canvas",
      "--color-surface",
      "--color-surface-2",
      "--color-needs-you",
      "--color-text",
      "--color-text-2",
      "--color-text-muted",
      "--color-border",
      "--color-border-strong",
      "--color-accent",
      "--color-accent-text-on",
      "--color-link",
      "--color-focus",
      "--color-agent",
      "--shadow-1",
      "--shadow-2",
      "--shadow-3",
      "--shadow-soft",
    ])
      expect(css).toContain(`${name}:`);
  });
});

// [foreground, background, spec ratio] — the spec's own numbers, rounded as it rounds them.
const PAIRS: [string, string, string, number][] = [
  ["text on canvas (light)", L.text, L.canvas, 13.7],
  ["text-muted on canvas (light)", L["text-muted"], L.canvas, 5.9],
  ["border-strong on canvas (light), controls need 3:1", L["border-strong"], L.canvas, 3.3],
  ["ink on accent (light)", L["accent-text-on"], L.accent, 5.8],
  ["link on canvas (light)", L.link, L.canvas, 4.6],
  ["link on surface (light)", L.link, L.surface, 5.06],
  ["focus on canvas (light)", L.focus, L.canvas, 8.6],
  ["agent on canvas (light)", L.agent, L.canvas, 5.6],
  ["text on canvas (dark)", D.text, D.canvas, 15.9],
  ["text-muted on canvas (dark)", D["text-muted"], D.canvas, 7.8],
  ["border-strong on canvas (dark)", D["border-strong"], D.canvas, 3.8],
  ["ink on accent (dark)", D["accent-text-on"], D.accent, 6.8],
  ["link on canvas (dark)", D.link, D.canvas, 10.1],
  ["focus on canvas (dark)", D.focus, D.canvas, 10.1],
  ["agent on canvas (dark)", D.agent, D.canvas, 9.2],
];

describe("contrast", () => {
  it.each(PAIRS)("%s meets the spec", (_label, fg, bg, ratio) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(ratio - 0.06);
  });

  it("pastel red is never text: it fails as text on canvas, which is why it is a fill only", () => {
    expect(contrast(L.accent, L.canvas)).toBeLessThan(3);
  });

  it.each(Object.entries(tokens.status))(
    "status %s: text on its tint is at least 6.6:1",
    (_n, s) => {
      expect(contrast(s.text, s.tint)).toBeGreaterThanOrEqual(6.6);
    },
  );

  it.each(Object.entries(tokens.status))(
    "status %s: dark text on the dark canvas reads",
    (_n, s) => {
      expect(contrast(s.textDark, D.canvas)).toBeGreaterThanOrEqual(6.6);
    },
  );

  it.each(Object.entries(tokens.identity))(
    "identity swatch %s carries ink above 8:1",
    (_n, hex) => {
      expect(contrast(tokens.primitive["ink-900"], hex)).toBeGreaterThan(8);
    },
  );

  it("danger fill carries white text", () => {
    expect(contrast(L["danger-text-on"], L["danger-fill"])).toBeGreaterThanOrEqual(4.5);
  });

  it("text never goes below the 12px floor, and weights are 400, 500 or 600 only", () => {
    for (const t of Object.values(tokens.type)) {
      expect(t.size).toBeGreaterThanOrEqual(12);
      expect([400, 500, 600]).toContain(t.weight);
    }
  });
});

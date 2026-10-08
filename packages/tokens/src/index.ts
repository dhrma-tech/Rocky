import tokens from "./tokens.json" with { type: "json" };

/**
 * Rocky's design tokens (UI spec "Design language and tokens"): one JSON source for the app, the
 * landing page and component stories. Three tiers: primitive (`--rocky-*`), semantic
 * (`--color-*`, `--space-*`, …) and component (`--button-*`, …). Components read semantic and
 * component tokens only. Themes switch with `data-theme="light|dark"` on the root, defaulting to
 * the system setting.
 */
export { tokens };

export type StatusTone = keyof typeof tokens.status;
export type IdentitySwatch = keyof typeof tokens.identity;
export type TypeStyle = keyof typeof tokens.type;

const px = (n: number) => (n === 0 ? "0" : `${n}px`);

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function block(selector: string, vars: [string, string][]): string {
  return `${selector} {\n${vars.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}\n`;
}

const semanticVars = (theme: "light" | "dark"): [string, string][] => {
  const s = tokens.semantic[theme];
  const status = Object.entries(tokens.status).flatMap(([name, t]): [string, string][] => {
    const text = theme === "light" ? t.text : t.textDark;
    // The spec gives dark text but no dark tint: a light wash of the text over the surface.
    const tint = theme === "light" ? t.tint : `color-mix(in srgb, ${t.textDark} 16%, ${s.surface})`;
    return [
      [`color-${name}-text`, text],
      [`color-${name}-tint`, tint],
    ];
  });
  const shadows = tokens.shadow[theme];
  return [
    ...Object.entries(s).map(([k, v]): [string, string] => [`color-${k}`, v]),
    ...status,
    ...Object.entries(shadows).map(([k, v]): [string, string] => [`shadow-${k}`, v]),
    ["elevation-edge", theme === "dark" ? tokens.shadow.darkEdge : "none"],
  ];
};

/** The generated stylesheet. Deterministic, so a test can check the committed file is current. */
export function renderCss(): string {
  const primitive: [string, string][] = [
    ...Object.entries(tokens.primitive).map(([k, v]): [string, string] => [`rocky-${k}`, v]),
    ...Object.entries(tokens.identity).map(([k, v]): [string, string] => [`rocky-swatch-${k}`, v]),
  ];
  const fonts = Object.entries(tokens.font).map(([k, v]): [string, string] => [`font-${k}`, v]);
  const type = Object.entries(tokens.type).flatMap(([k, t]): [string, string][] => [
    [`type-${k}-font`, `var(--font-${t.family})`],
    [`type-${k}-size`, px(t.size)],
    [`type-${k}-line`, px(t.line)],
    [`type-${k}-weight`, String(t.weight)],
  ]);
  const space = Object.entries(tokens.space).map(([k, v]): [string, string] => [
    `space-${k}`,
    px(v),
  ]);
  const radius = Object.entries(tokens.radius).map(([k, v]): [string, string] => [
    `radius-${k}`,
    px(v),
  ]);
  const motion = Object.entries(tokens.motion).map(([k, v]): [string, string] => [
    k.startsWith("ease") ? k : `duration-${k}`,
    v,
  ]);
  const layout = Object.entries(tokens.layout).map(([k, v]): [string, string] => [
    `layout-${k}`,
    typeof v === "number" ? px(v) : v,
  ]);
  const component = Object.entries(tokens.component).map(([k, v]): [string, string] => [
    k,
    k.endsWith("-ms") ? `${v}ms` : px(v as number),
  ]);
  // Component tier: named for jobs on components, built from semantic tokens only.
  const comp: [string, string][] = [
    ["button-height", "var(--control-height)"],
    ["button-radius", "var(--radius-control)"],
    ["button-primary-bg", "var(--color-accent)"],
    ["button-primary-bg-hover", "var(--color-accent-hover)"],
    ["button-primary-bg-pressed", "var(--color-accent-pressed)"],
    ["button-primary-text", "var(--color-accent-text-on)"],
    ["button-secondary-bg", "var(--color-surface)"],
    ["button-secondary-border", "var(--color-border-strong)"],
    ["button-danger-bg", "var(--color-danger-fill)"],
    ["button-danger-text", "var(--color-danger-text-on)"],
    ["input-bg", "var(--color-surface)"],
    ["input-border", "var(--color-border-strong)"],
    ["card-bg", "var(--color-surface)"],
    ["card-border", "var(--color-border)"],
    ["card-radius", "var(--radius-card)"],
    ["card-shadow", "var(--shadow-1)"],
    [
      "focus-ring",
      "0 0 0 var(--focus-offset) var(--color-canvas), 0 0 0 calc(var(--focus-offset) + var(--focus-width)) var(--color-focus)",
    ],
  ];
  const header = `/* Generated from packages/tokens/src/tokens.json by \`pnpm tokens\`. Do not edit by hand. */\n`;
  const light = semanticVars("light");
  const dark = semanticVars("dark");
  return [
    header,
    block(":root", [
      ...primitive,
      ...fonts,
      ...type,
      ...space,
      ...radius,
      ...motion,
      ...layout,
      ...component,
      ...light,
      ...comp,
    ]),
    ":root {\n  color-scheme: light;\n}\n",
    block(':root[data-theme="dark"]', dark),
    ':root[data-theme="dark"] {\n  color-scheme: dark;\n}\n',
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark)
      .split("\n")
      .map((l) => (l ? `  ${l}` : l))
      .join("\n")}  :root:not([data-theme="light"]) {\n    color-scheme: dark;\n  }\n}\n`,
    // Reduced motion: movement becomes instant; nothing is lost, because state never lives in motion.
    "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --duration-micro: 0ms;\n    --duration-ui: 0ms;\n    --duration-panel: 0ms;\n    --duration-landing: 0ms;\n  }\n}\n",
  ].join("\n");
}

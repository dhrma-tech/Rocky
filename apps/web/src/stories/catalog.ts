import type { ComponentType } from "react";

/**
 * Component stories in Component Story Format (CSF): a module's default export names it, each
 * other export is one story. Ladle and Storybook read the same files, so stories stay portable
 * (docs/DECISIONS.md D-033); this catalog renders them on the app's own Vite build.
 */
export interface Meta {
  title: string;
}

export interface StoryParameters {
  /** Interactive states the visual tests also capture by hovering or focusing the first control. */
  states?: ("hover" | "focus")[];
  /** Wide stories (screens, layouts) are captured at every breakpoint. */
  layout?: "component" | "screen";
}

export type Story = ComponentType & { storyName?: string; parameters?: StoryParameters };

export interface StoryEntry {
  /** "controls-button--primary": stable, URL-safe, used by the visual tests. */
  id: string;
  group: string;
  name: string;
  Component: Story;
  parameters: StoryParameters;
}

const slug = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

type StoryModule = { default: Meta } & Record<string, unknown>;

export function collect(modules: Record<string, StoryModule>): StoryEntry[] {
  const out: StoryEntry[] = [];
  for (const mod of Object.values(modules)) {
    const meta = mod.default;
    for (const [key, value] of Object.entries(mod)) {
      if (key === "default" || typeof value !== "function") continue;
      const story = value as Story;
      out.push({
        id: `${slug(meta.title)}--${slug(key)}`,
        group: meta.title,
        name: story.storyName ?? key.replace(/([a-z])([A-Z])/g, "$1 $2"),
        Component: story,
        parameters: story.parameters ?? {},
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

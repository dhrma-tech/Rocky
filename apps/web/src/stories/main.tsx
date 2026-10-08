import "@fontsource-variable/inter/wght.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { collect } from "./catalog.ts";

/**
 * The component catalog (dev only; not part of the production build).
 *   /stories.html                      index of every story
 *   /stories.html?story=<id>           one story alone (visual and axe tests)
 *   &theme=dark|light                  force a theme
 */
const stories = collect(import.meta.glob("../**/*.stories.tsx", { eager: true }));
const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

function Index() {
  const groups = [...new Set(stories.map((s) => s.group))];
  return (
    <main className="mx-auto max-w-[960px] p-6">
      <h1 style={{ font: "var(--type-title-size)/var(--type-title-line) var(--font-serif)" }}>
        Rocky components
      </h1>
      {groups.map((g) => (
        <section key={g} className="mt-6">
          <h2 className="font-semibold">{g}</h2>
          <ul>
            {stories
              .filter((s) => s.group === g)
              .map((s) => (
                <li key={s.id}>
                  <a href={`?story=${s.id}`}>{s.name}</a>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function One({ id }: { id: string }) {
  const s = stories.find((x) => x.id === id);
  if (!s) return <p role="alert">No story {id}</p>;
  const { Component } = s;
  return (
    <main
      data-story={s.id}
      className={s.parameters.layout === "screen" ? "" : "p-12"}
      aria-label={`${s.group}: ${s.name}`}
    >
      <Component />
    </main>
  );
}

const id = params.get("story");
// The visual tests read the list from here.
(window as unknown as { __stories: unknown }).__stories = stories.map((s) => ({
  id: s.id,
  parameters: s.parameters,
}));
const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode>{id ? <One id={id} /> : <Index />}</StrictMode>);

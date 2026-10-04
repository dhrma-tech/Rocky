export type Theme = "system" | "light" | "dark";

const KEY = "rocky.theme";

/** `data-theme` on :root; absent means follow the system (DESIGN.md §5.11). */
export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function setTheme(t: Theme): void {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Storage may be unavailable; the choice then lasts for this page only.
  }
  applyTheme(t);
}

export function applyTheme(t: Theme = getTheme()): void {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}

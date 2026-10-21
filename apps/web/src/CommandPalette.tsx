import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { projects } from "./api.ts";
import { CATEGORIES } from "./settings-categories.ts";
import { openTaskCreator } from "./TaskCreator.tsx";

/**
 * Command palette (UI spec "Command palette"): Ctrl/Cmd+K, one input, groups for Actions, Go to,
 * Projects and Settings, recent first, shortcuts shown. Every command also exists in the UI; this
 * is only a faster way there. Native <dialog> + the ARIA combobox/listbox pattern.
 */

type Group = "Recent" | "Actions" | "Go to" | "Projects" | "Settings";
interface Command {
  id: string;
  group: Exclude<Group, "Recent">;
  title: string;
  words?: string;
  shortcut?: string;
  run: () => void;
}

const RECENT_KEY = "rocky.palette.recent";
const readRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5)),
    );
  } catch {
    // Private windows can refuse storage; the palette still works without recents.
  }
};
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export function CommandPalette({ toggleSidebar }: { toggleSidebar: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("rocky:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rocky:palette", onOpen);
    };
  }, []);
  return open ? <Palette onClose={() => setOpen(false)} toggleSidebar={toggleSidebar} /> : null;
}

/** Opens the palette from a button (the sidebar's search button). */
export const openPalette = () => window.dispatchEvent(new Event("rocky:palette"));

function Palette({ onClose, toggleSidebar }: { onClose: () => void; toggleSidebar: () => void }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const base = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const projectList = useQuery({ queryKey: ["projects"], queryFn: projects.list, retry: false });

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string, search?: Record<string, string>) => () =>
      void navigate({ to, ...(search ? { search } : {}) } as Parameters<typeof navigate>[0]);
    const pages: [string, string, string?][] = [
      ["/", "Today", "home dashboard"],
      ["/approvals", "Approvals", "queue review approve deny"],
      ["/projects", "Projects", "folders workspaces"],
      ["/tasks", "Tasks", "running"],
      ["/tasks/history", "Task history", "past runs archive"],
      ["/tasks/background", "Background routines", "schedule routines pause"],
      ["/ledger", "Ledger", "activity audit events"],
      ["/memory", "Memory", "remember facts profile"],
      ["/files", "Files", "read documents folders disk"],
      ["/notebooks", "Notebooks", "study"],
      ["/commitments", "Commitments", "promises deadlines"],
      ["/connectors", "Integrations", "connect tools gmail calendar"],
      ["/settings", "Settings", "preferences"],
      ["/profile", "Profile", "name colour color you rocky avatar"],
      ["/help", "Help", "docs support diagnostics shortcuts"],
      ["/notifications", "Notifications", "bell alerts quiet hours unread"],
    ];
    return [
      {
        id: "a:task",
        group: "Actions",
        title: "New task",
        words: "create routine schedule start",
        run: openTaskCreator,
      },
      {
        id: "a:ask",
        group: "Actions",
        title: "Ask Rocky a question",
        words: "chat",
        run: go("/ask"),
      },
      {
        id: "a:routine",
        group: "Actions",
        title: "New routine",
        words: "schedule brief",
        run: go("/tasks/background"),
      },
      {
        id: "a:project",
        group: "Actions",
        title: "New project from a folder",
        words: "add folder",
        run: go("/projects"),
      },
      {
        id: "a:sidebar",
        group: "Actions",
        title: "Collapse or open the sidebar",
        shortcut: `${MOD}B`,
        run: toggleSidebar,
      },
      ...pages.map(([to, title, words]) => ({
        id: `g:${to}`,
        group: "Go to" as const,
        title,
        ...(words ? { words } : {}),
        run: go(to),
      })),
      ...(projectList.data?.projects ?? [])
        .filter((p) => p.archivedAt === null)
        .map((p) => ({
          id: `p:${p.id}`,
          group: "Projects" as const,
          title: p.name,
          words: p.folder,
          run: () => void navigate({ to: "/projects/$id", params: { id: p.id } }),
        })),
      ...CATEGORIES.map((c) => ({
        id: `s:${c.id}`,
        group: "Settings" as const,
        title: `Settings: ${c.title}`,
        words: c.words,
        run: go("/settings", { section: c.id }),
      })),
    ];
  }, [navigate, toggleSidebar, projectList.data]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (c: Command) => {
      const hay = `${c.title} ${c.words ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    if (words.length)
      return commands.filter(match).map((c) => ({ ...c, shownIn: c.group as Group }));
    const recent = readRecent()
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is Command => Boolean(c));
    return [
      ...recent.map((c) => ({ ...c, shownIn: "Recent" as Group })),
      ...commands
        .filter((c) => !recent.includes(c))
        .map((c) => ({ ...c, shownIn: c.group as Group })),
    ];
  }, [commands, query]);

  useEffect(() => {
    document.getElementById(`${base}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, base]);

  const run = (c: Command) => {
    remember(c.id);
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = shown[active];
      if (c) run(c);
    }
  };

  const groups: Group[] = ["Recent", "Actions", "Go to", "Projects", "Settings"];
  let index = -1;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Esc closes natively
    <dialog
      ref={ref}
      className="rk-palette"
      aria-label="Command palette"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rk-palette__search">
        <Search size={20} strokeWidth={1.5} aria-hidden />
        <input
          className="rk-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${base}-list`}
          aria-activedescendant={shown.length ? `${base}-opt-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search commands"
          placeholder="Go to, ask, or change a setting…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <kbd className="rk-kbd">Esc</kbd>
      </div>
      <div id={`${base}-list`} role="listbox" aria-label="Commands" className="rk-palette__list">
        {groups.map((g) => {
          const items = shown.filter((c) => c.shownIn === g);
          if (!items.length) return null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a listbox group (ARIA); fieldset can't sit in a listbox
            <div key={g} role="group" aria-labelledby={`${base}-g-${g}`}>
              <p id={`${base}-g-${g}`} className="rk-palette__group">
                {g}
              </p>
              {items.map((c) => {
                index++;
                const i = index;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: options stay unfocusable; the combobox input drives them (aria-activedescendant)
                  <div
                    key={`${g}-${c.id}`}
                    id={`${base}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="rk-palette__opt"
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(c)}
                  >
                    <span>{c.title}</span>
                    {c.shortcut && <kbd className="rk-kbd">{c.shortcut}</kbd>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className="rk-palette__empty">Nothing matches “{query}”.</p>}
      </div>
    </dialog>
  );
}

export const paletteShortcut = `${MOD}K`;

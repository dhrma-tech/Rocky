import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
  BookOpen,
  CalendarCheck,
  House,
  Layers,
  ListChecks,
  MessageSquareText,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Repeat,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import { RecordingPill } from "./components/capture.tsx";
import { LocalBadge } from "./components/trust.tsx";
import { cls, IconButton } from "./components/ui.tsx";

const NAV = [
  { to: "/", label: "Home", icon: House },
  { to: "/ask", label: "Ask", icon: MessageSquareText },
  { to: "/notebooks", label: "Notebooks", icon: BookOpen },
  { to: "/study", label: "Study", icon: Layers },
  { to: "/meetings", label: "Meetings", icon: Mic },
  { to: "/commitments", label: "Commitments", icon: CalendarCheck },
  { to: "/actions", label: "Actions", icon: ListChecks },
  { to: "/routines", label: "Routines", icon: Repeat },
  { to: "/connectors", label: "Connectors", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** App shell (DESIGN.md §5.1–5.2): 240 / 56 sidebar, fluid main, top-right local-only badge. */
export function Shell() {
  // Phones start with the icon rail so the page keeps its width (DESIGN §5.10).
  const [collapsed, setCollapsed] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, retry: false });
  const pending = useQuery({
    queryKey: ["actions", "draft"],
    queryFn: () => api.actions("draft"),
    refetchInterval: 15_000,
    enabled: settings.isSuccess,
  });
  const pendingCount = pending.data?.actions.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (settings.error instanceof ApiError && settings.error.status === 401) return <SignedOut />;

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-raised focus:p-2"
      >
        Skip to content
      </a>
      <nav
        aria-label="Main"
        className={cls(
          "flex shrink-0 flex-col gap-px border-r border-border-base bg-sidebar p-2 transition-[width] duration-[320ms] ease-out",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className="mb-2 flex items-center justify-between">
          {!collapsed && (
            <span className="flex size-10 items-center justify-center rounded-md font-display text-lg text-primary">
              R
            </span>
          )}
          <IconButton
            label={collapsed ? "Open sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? (
              <PanelLeftOpen size={20} aria-hidden />
            ) : (
              <PanelLeftClose size={20} aria-hidden />
            )}
          </IconButton>
        </div>
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            aria-label={collapsed ? label : undefined}
            className="relative flex h-10 items-center gap-3 rounded-md px-3 text-sm text-primary no-underline transition-colors duration-[180ms] ease-ui hover:bg-layer-subtle"
            activeProps={{
              className:
                "bg-accent-soft before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent-strong",
            }}
            activeOptions={{ exact: to === "/" }}
          >
            <Icon size={20} aria-hidden className="shrink-0 text-accent-strong" />
            {!collapsed && label}
            {to === "/actions" && pendingCount > 0 && (
              <span
                className={cls(
                  "rounded-full bg-accent px-1.5 text-[11px] font-medium leading-4 text-on-accent",
                  collapsed ? "absolute right-1 top-1" : "ml-auto",
                )}
              >
                {pendingCount}
                <span className="sr-only"> waiting for approval</span>
              </span>
            )}
          </Link>
        ))}
      </nav>
      <RecordingPill />
      <main id="main" className="relative min-w-0 flex-1">
        <div className="absolute right-4 top-3 z-10">
          <LocalBadge localOnly={settings.data?.localOnly} />
        </div>
        <Outlet />
      </main>
    </div>
  );
}

function SignedOut() {
  return (
    <main className="flex h-full items-center justify-center px-4">
      <div className="max-w-md rounded-lg bg-raised p-8 shadow-raised-md">
        <h1 className="text-2xl font-normal leading-8">Sign in to Rocky</h1>
        <p className="mt-2 text-secondary">
          This browser has no session. In a terminal, run{" "}
          <code className="font-mono text-sm">rocky open</code> and open the link it prints.
        </p>
      </div>
    </main>
  );
}

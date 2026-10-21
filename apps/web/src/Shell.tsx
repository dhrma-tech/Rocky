import type { NotificationPrefs } from "@rocky/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  CalendarCheck,
  CircleHelp,
  Files,
  FolderOpen,
  Hand,
  House,
  ListChecks,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LiveProvider, useLive, useOverallState } from "./agent-ui/live.tsx";
import { Pebble } from "./agent-ui/Pebble.tsx";
import { activeRuns } from "./agent-ui/runs.ts";
import { StatusChip } from "./agent-ui/StatusChip.tsx";
import { ApiError, api, onboarding, type Swatch } from "./api.ts";
import { CommandPalette, openPalette, paletteShortcut } from "./CommandPalette.tsx";
import { RecordingPill } from "./components/capture.tsx";
import { LocalBadge } from "./components/trust.tsx";
import { GlobalHelpKeys } from "./help/shortcuts.tsx";
import { NotificationBell, useSystemNotifications } from "./notifications.tsx";
import { TaskCreator } from "./TaskCreator.tsx";
import { Avatar, Banner, Button, IconButton, ToastProvider } from "./ui/index.tsx";
import "./shell.css";

/**
 * App shell (UI spec "App shell", docs/DECISIONS.md D-018). Sidebar: Today, Approvals, Projects,
 * Tasks; Library: Memory, Files, Notebooks, Commitments, Integrations; footer: Help, Settings,
 * notifications (bell), your profile, search (Ctrl+K). Rocky's pebble and state chip sit at
 * the top so the agent's state shows on every screen.
 */

interface NavItem {
  to:
    | "/"
    | "/approvals"
    | "/projects"
    | "/tasks"
    | "/memory"
    | "/files"
    | "/notebooks"
    | "/commitments"
    | "/connectors"
    | "/settings"
    | "/help";
  label: string;
  icon: LucideIcon;
}
const PRIMARY: NavItem[] = [
  { to: "/", label: "Today", icon: House },
  { to: "/approvals", label: "Approvals", icon: Hand },
  { to: "/projects", label: "Projects", icon: FolderOpen },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
];
const LIBRARY: NavItem[] = [
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/files", label: "Files", icon: Files },
  { to: "/notebooks", label: "Notebooks", icon: BookOpen },
  { to: "/commitments", label: "Commitments", icon: CalendarCheck },
  { to: "/connectors", label: "Integrations", icon: Plug },
];
const FOOTER: NavItem[] = [
  { to: "/help", label: "Help", icon: CircleHelp },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Shell() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, retry: false });
  const setup = useQuery({
    queryKey: ["onboarding"],
    queryFn: onboarding.get,
    enabled: settings.isSuccess,
  });
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const firstRun = setup.data?.firstRun === true;
  // A fresh install starts in onboarding (UI spec 3); an install with data never does.
  useEffect(() => {
    if (firstRun && path !== "/welcome") void navigate({ to: "/welcome", replace: true });
  }, [firstRun, path, navigate]);

  if (settings.error instanceof ApiError && settings.error.status === 401) return <SignedOut />;
  // Onboarding is a centred column without the sidebar.
  if (path === "/welcome")
    return (
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    );
  return (
    <ToastProvider>
      <LiveProvider enabled={settings.isSuccess}>
        <ShellFrame
          engineDown={settings.isError}
          localOnly={settings.data?.localOnly}
          prefs={settings.data?.notifications}
          retry={() => void settings.refetch()}
          lastSeen={settings.dataUpdatedAt}
          name={setup.data?.name ?? "Rocky"}
          swatch={setup.data?.swatch ?? "periwinkle"}
          userName={setup.data?.userName ?? null}
        />
      </LiveProvider>
    </ToastProvider>
  );
}

function ShellFrame({
  engineDown,
  localOnly,
  prefs,
  retry,
  lastSeen,
  name,
  swatch,
  userName,
}: {
  engineDown: boolean;
  localOnly: boolean | undefined;
  prefs: NotificationPrefs | undefined;
  retry: () => void;
  lastSeen: number;
  name: string;
  swatch: Swatch;
  userName: string | null;
}) {
  // Phones start with the icon rail so the page keeps its width; the tab bar comes in P3.
  const [rail, setRail] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  const pending = useQuery({
    queryKey: ["actions", "draft"],
    queryFn: () => api.actions("draft"),
    enabled: !engineDown,
  });
  const pendingCount = pending.data?.actions.length ?? 0;
  const live = useLive();
  const state = useOverallState(pendingCount);
  // UI spec "Background" state: a calm count in the sidebar, no animation.
  const runningCount = activeRuns(live.runs).length;
  useSystemNotifications(engineDown ? undefined : prefs);

  const toggleRail = useCallback(() => setRail((r) => !r), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setRail((r) => !r);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const item = ({ to, label, icon: Icon }: NavItem) => {
    const link = (
      <Link
        to={to}
        className="rk-nav"
        activeProps={{ className: "active" }}
        activeOptions={{ exact: to === "/" }}
        aria-label={rail ? label : undefined}
      >
        <Icon size={20} strokeWidth={1.5} aria-hidden />
        {!rail && label}
        {to === "/approvals" && pendingCount > 0 && (
          <span className="rk-nav__badge">
            {pendingCount}
            <span className="sr-only"> waiting for you</span>
          </span>
        )}
        {to === "/tasks" && runningCount > 0 && (
          <span className="rk-nav__count">
            {runningCount}
            <span className={rail ? "sr-only" : undefined}> running</span>
          </span>
        )}
      </Link>
    );
    return rail ? (
      <span key={to} className="rk-tip rk-tip--right">
        {link}
        <span className="rk-tip__text" aria-hidden="true">
          {label}
        </span>
      </span>
    ) : (
      <span key={to} style={{ display: "contents" }}>
        {link}
      </span>
    );
  };

  return (
    <div className="rk-shell">
      <a href="#main" className="rk-skip">
        Skip to content
      </a>
      <nav aria-label="Main" className="rk-side" data-rail={rail}>
        <div className="rk-side__top">
          <Pebble
            state={state}
            size={rail ? 32 : 40}
            swatch={swatch}
            label={rail ? name : undefined}
          />
          {!rail && (
            <div className="rk-side__status">
              <strong>{name}</strong>
              {state ? (
                <StatusChip state={state} />
              ) : (
                <span className="rk-small rk-muted">At rest</span>
              )}
              <Link to="/ledger">Open the ledger</Link>
              <LocalBadge localOnly={localOnly} />
            </div>
          )}
        </div>
        {PRIMARY.map(item)}
        {!rail && <p className="rk-side__group">Library</p>}
        {LIBRARY.map(item)}
        <div className="rk-side__foot">
          {rail ? (
            <span className="rk-tip rk-tip--right">
              <NotificationBell rail />
              <span className="rk-tip__text" aria-hidden="true">
                Notifications
              </span>
            </span>
          ) : (
            <NotificationBell rail={false} />
          )}
          {FOOTER.map(item)}
          <Link
            to="/profile"
            className="rk-nav"
            activeProps={{ className: "active" }}
            aria-label={rail ? `Profile: ${userName ?? "you"}` : undefined}
          >
            <Avatar name={userName ?? "You"} size={24} />
            {!rail && (userName ?? "Profile")}
          </Link>
          <IconButton
            label={`Search and commands (${paletteShortcut})`}
            tipSide="right"
            onClick={openPalette}
          >
            <Search size={20} strokeWidth={1.5} aria-hidden />
          </IconButton>
          <IconButton
            label={rail ? "Open sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
            tipSide="right"
            onClick={() => setRail((r) => !r)}
          >
            {rail ? (
              <PanelLeftOpen size={20} strokeWidth={1.5} aria-hidden />
            ) : (
              <PanelLeftClose size={20} strokeWidth={1.5} aria-hidden />
            )}
          </IconButton>
        </div>
      </nav>
      <RecordingPill />
      <CommandPalette toggleSidebar={toggleRail} />
      <GlobalHelpKeys />
      <TaskCreator />
      <main id="main" className="rk-main">
        <div className="rk-main__banners">
          {engineDown && (
            <Banner
              tone="error"
              title="Rocky's engine isn't responding."
              actions={
                <>
                  <Button variant="primary" onClick={retry}>
                    Retry
                  </Button>
                  <span className="rk-small">
                    Start it with <code className="rk-mono">rocky daemon</code>.
                  </span>
                </>
              }
            >
              {lastSeen
                ? `Last seen at ${new Date(lastSeen).toLocaleTimeString()}. What is below is read-only until it is back.`
                : "What is below is read-only until it is back."}
            </Banner>
          )}
          {!engineDown && live.stream === "reconnecting" && (
            <Banner tone="info" title="Connection lost. Reconnecting…">
              Missed updates are replayed when it is back.
            </Banner>
          )}
        </div>
        <div className="rk-main__content" inert={engineDown || undefined}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function SignedOut() {
  return (
    <main className="rk-page" style={{ maxWidth: 480, paddingTop: 96 }}>
      <h1 className="rk-title">Open Rocky from the terminal</h1>
      <p>
        This browser has no session. In a terminal, run <code className="rk-mono">rocky open</code>{" "}
        and open the link it prints.
      </p>
    </main>
  );
}

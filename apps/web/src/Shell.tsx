import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
  BookOpen,
  CalendarCheck,
  Hand,
  House,
  ListChecks,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { LiveProvider, useLive, useOverallState } from "./agent-ui/live.tsx";
import { Pebble } from "./agent-ui/Pebble.tsx";
import { StatusChip } from "./agent-ui/StatusChip.tsx";
import { ApiError, api } from "./api.ts";
import { RecordingPill } from "./components/capture.tsx";
import { LocalBadge } from "./components/trust.tsx";
import { Banner, Button, IconButton, ToastProvider } from "./ui/index.tsx";
import "./shell.css";

/**
 * App shell (UI spec "App shell", docs/DECISIONS.md D-018). Sidebar: Today, Approvals, Tasks;
 * Library: Notebooks, Commitments, Integrations; footer: Settings. Projects, Memory, Files,
 * Notifications, Help and the profile join as their screens ship (P2, P3). Rocky's pebble and
 * state chip sit at the top so the agent's state shows on every screen.
 */

interface NavItem {
  to: "/" | "/approvals" | "/tasks" | "/notebooks" | "/commitments" | "/connectors" | "/settings";
  label: string;
  icon: LucideIcon;
}
const PRIMARY: NavItem[] = [
  { to: "/", label: "Today", icon: House },
  { to: "/approvals", label: "Approvals", icon: Hand },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
];
const LIBRARY: NavItem[] = [
  { to: "/notebooks", label: "Notebooks", icon: BookOpen },
  { to: "/commitments", label: "Commitments", icon: CalendarCheck },
  { to: "/connectors", label: "Integrations", icon: Plug },
];
const FOOTER: NavItem[] = [{ to: "/settings", label: "Settings", icon: Settings }];

export function Shell() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, retry: false });
  if (settings.error instanceof ApiError && settings.error.status === 401) return <SignedOut />;
  return (
    <ToastProvider>
      <LiveProvider enabled={settings.isSuccess}>
        <ShellFrame
          engineDown={settings.isError}
          localOnly={settings.data?.localOnly}
          retry={() => void settings.refetch()}
          lastSeen={settings.dataUpdatedAt}
        />
      </LiveProvider>
    </ToastProvider>
  );
}

function ShellFrame({
  engineDown,
  localOnly,
  retry,
  lastSeen,
}: {
  engineDown: boolean;
  localOnly: boolean | undefined;
  retry: () => void;
  lastSeen: number;
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
          <Pebble state={state} size={rail ? 32 : 40} label={rail ? "Rocky" : undefined} />
          {!rail && (
            <div className="rk-side__status">
              <strong>Rocky</strong>
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
          {FOOTER.map(item)}
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

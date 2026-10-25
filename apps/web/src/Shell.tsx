import type { NotificationPrefs } from "@rocky/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  BookOpen,
  Brain,
  CalendarCheck,
  CircleHelp,
  Ellipsis,
  Files,
  FolderOpen,
  Hand,
  House,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { LiveProvider, useLive, useOverallState } from "./agent-ui/live.tsx";
import { Pebble } from "./agent-ui/Pebble.tsx";
import { activeRuns } from "./agent-ui/runs.ts";
import { StatusChip } from "./agent-ui/StatusChip.tsx";
import { ApiError, api, onAnotherDevice, onboarding, type Swatch } from "./api.ts";
import { CommandPalette, openPalette, paletteShortcut } from "./CommandPalette.tsx";
import { RecordingPill } from "./components/capture.tsx";
import { type Boundary, LocalBadge } from "./components/trust.tsx";
import { GlobalHelpKeys } from "./help/shortcuts.tsx";
import { NotificationBell, useNotifications, useSystemNotifications } from "./notifications.tsx";
import { TaskCreator } from "./TaskCreator.tsx";
import { Avatar, Banner, Button, Drawer, IconButton, ToastProvider } from "./ui/index.tsx";
import "./shell.css";

/**
 * App shell (UI spec "App shell", docs/DECISIONS.md D-018). Sidebar: Today, Approvals, Projects,
 * Tasks; Library: Memory, Files, Notebooks, Commitments, Integrations; footer: notifications
 * (bell), Help, Settings, your profile, search (Ctrl+K). Rocky's pebble and state chip sit at the
 * top so the agent's state shows on every screen.
 *
 * Phones (UI spec 23, under 600px): a top bar with the pebble and state, and a bottom tab bar
 * (Today, Approvals, Tasks, Chat, More); everything else lives in the More sheet. Tablets
 * (600–899px) get the icon rail, which follows the window until the user toggles it (Ctrl+B).
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
    | "/help"
    | "/ask"
    | "/notifications";
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
/** The phone tab bar (UI spec 23); More holds the rest. */
const TABS: NavItem[] = [
  { to: "/", label: "Today", icon: House },
  { to: "/approvals", label: "Approvals", icon: Hand },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
  { to: "/ask", label: "Chat", icon: MessageSquare },
];
const MORE: NavItem[] = [
  { to: "/projects", label: "Projects", icon: FolderOpen },
  ...LIBRARY,
  { to: "/notifications", label: "Notifications", icon: Bell },
  ...FOOTER,
];

/** True while the media query matches; follows resizes and rotation. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

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

  // Pairing a phone is the way in, so it needs no session (docs/PHONE.md).
  if (path === "/pair")
    return (
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    );
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
          reaching={settings.isPending}
          boundary={
            settings.data
              ? settings.data.localOnly
                ? "local_only"
                : (settings.data.routing?.mode ?? "local_first")
              : undefined
          }
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
  reaching,
  boundary,
  prefs,
  retry,
  lastSeen,
  name,
  swatch,
  userName,
}: {
  engineDown: boolean;
  reaching: boolean;
  boundary: Boundary | undefined;
  prefs: NotificationPrefs | undefined;
  retry: () => void;
  lastSeen: number;
  name: string;
  swatch: Swatch;
  userName: string | null;
}) {
  const phone = useMedia("(max-width: 599px)");
  const narrow = useMedia("(max-width: 899px)");
  // The rail follows the window until the user picks; then their choice holds.
  const [railChoice, setRailChoice] = useState<boolean | null>(null);
  const rail = railChoice ?? narrow;
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

  const toggleRail = useCallback(() => setRailChoice((r) => !(r ?? narrow)), [narrow]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  const badges = (to: NavItem["to"], compact: boolean) => (
    <>
      {to === "/approvals" && pendingCount > 0 && (
        <span className="rk-nav__badge">
          {pendingCount}
          <span className="sr-only"> waiting for you</span>
        </span>
      )}
      {to === "/tasks" && runningCount > 0 && (
        <span className="rk-nav__count">
          {runningCount}
          <span className={compact ? "sr-only" : undefined}> running</span>
        </span>
      )}
    </>
  );

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
        {badges(to, rail)}
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

  const status = (
    <div className="rk-side__status">
      <strong>{name}</strong>
      {state ? <StatusChip state={state} /> : <span className="rk-small rk-muted">At rest</span>}
      <Link to="/ledger">Open the ledger</Link>
      <LocalBadge boundary={boundary} />
    </div>
  );

  const banners = (
    <div className="rk-main__banners">
      {engineDown &&
        (onAnotherDevice() ? (
          <Banner
            tone="error"
            title="Can't reach your computer. It may be asleep."
            actions={
              <Button variant="primary" onClick={retry}>
                Retry
              </Button>
            }
          >
            {lastSeen
              ? `Last synced at ${new Date(lastSeen).toLocaleTimeString()}. What is below is read-only until it is back.`
              : "Wake it, or check that Rocky is running there."}
          </Banner>
        ) : (
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
        ))}
      {reaching && onAnotherDevice() && (
        <Banner tone="info" title="Reaching your computer…">
          Rocky runs there; this page shows it once it answers.
        </Banner>
      )}
      {!engineDown && live.stream === "reconnecting" && (
        <Banner tone="info" title="Connection lost. Reconnecting…">
          Missed updates are replayed when it is back.
        </Banner>
      )}
    </div>
  );

  const main = (
    <main id="main" className="rk-main">
      {banners}
      <div className="rk-main__content" inert={engineDown || undefined}>
        <Outlet />
      </div>
    </main>
  );

  const overlays = (
    <>
      <RecordingPill />
      <CommandPalette toggleSidebar={toggleRail} />
      <GlobalHelpKeys />
      <TaskCreator />
    </>
  );

  if (phone)
    return (
      <div className="rk-shell rk-shell--phone">
        <a href="#main" className="rk-skip">
          Skip to content
        </a>
        <header className="rk-topbar">
          <Pebble state={state} size={32} swatch={swatch} label={name} />
          <strong className="rk-topbar__name">{name}</strong>
          {state && <StatusChip state={state} />}
          <span style={{ flex: 1 }} />
          <LocalBadge boundary={boundary} />
        </header>
        {main}
        <PhoneTabs badges={badges} status={status} userName={userName} />
        {overlays}
      </div>
    );

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
          {!rail && status}
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
            onClick={toggleRail}
          >
            {rail ? (
              <PanelLeftOpen size={20} strokeWidth={1.5} aria-hidden />
            ) : (
              <PanelLeftClose size={20} strokeWidth={1.5} aria-hidden />
            )}
          </IconButton>
        </div>
      </nav>
      {overlays}
      {main}
    </div>
  );
}

/** Bottom tab bar and the More sheet (UI spec 23). */
function PhoneTabs({
  badges,
  status,
  userName,
}: {
  badges: (to: NavItem["to"], compact: boolean) => ReactNode;
  status: ReactNode;
  userName: string | null;
}) {
  const [more, setMore] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const unread = useNotifications("all", 10).data?.unread ?? 0;
  // Following a link in the sheet closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation only
  useEffect(() => setMore(false), [path]);
  const inMore =
    MORE.some((m) => path === m.to || path.startsWith(`${m.to}/`)) || path === "/profile";
  return (
    <>
      <nav aria-label="Main" className="rk-tabbar">
        {TABS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="rk-tabbar__item"
            activeProps={{ className: "active" }}
            activeOptions={{ exact: to === "/" }}
          >
            <Icon size={24} strokeWidth={1.5} aria-hidden />
            <span>{label}</span>
            {badges(to, true)}
          </Link>
        ))}
        <button
          type="button"
          className={`rk-tabbar__item${inMore ? " active" : ""}`}
          aria-expanded={more}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <Ellipsis size={24} strokeWidth={1.5} aria-hidden />
          <span>More</span>
          {unread > 0 && (
            <span className="rk-nav__badge">
              {unread}
              <span className="sr-only"> unread notifications</span>
            </span>
          )}
        </button>
      </nav>
      <Drawer open={more} onClose={() => setMore(false)} title="More">
        <div className="rk-more">
          {status}
          <ul className="rk-more__list">
            {MORE.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <Link to={to} className="rk-nav" activeProps={{ className: "active" }}>
                  <Icon size={20} strokeWidth={1.5} aria-hidden />
                  {label}
                  {to === "/notifications" && unread > 0 && (
                    <span className="rk-nav__badge">
                      {unread}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
            <li>
              <Link to="/profile" className="rk-nav" activeProps={{ className: "active" }}>
                <Avatar name={userName ?? "You"} size={24} />
                {userName ?? "Profile"}
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="rk-nav"
                onClick={() => {
                  setMore(false);
                  openPalette();
                }}
              >
                <Search size={20} strokeWidth={1.5} aria-hidden />
                Search and commands
              </button>
            </li>
          </ul>
        </div>
      </Drawer>
    </>
  );
}

function SignedOut() {
  if (onAnotherDevice())
    return (
      <main className="rk-page" style={{ maxWidth: 480, paddingTop: 96 }}>
        <h1 className="rk-title">Pair this phone first</h1>
        <p>
          This phone isn't paired with Rocky yet, or it was signed out. Make a pairing code on your
          computer, in Settings › Phone and devices.
        </p>
        <Link to="/pair" className="rk-button rk-button--primary">
          Pair this phone
        </Link>
      </main>
    );
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

import {
  channelTakes,
  inQuietHours,
  type Notification,
  type NotificationKind,
  type NotificationPrefs,
} from "@rocky/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  CalendarClock,
  CircleCheck,
  Hand,
  Info,
  type LucideIcon,
  ThumbsDown,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useLive } from "./agent-ui/live.tsx";
import { api } from "./api.ts";
import { Button, EmptyState, IconButton, Popover, Skeleton, useToast } from "./ui/index.tsx";
import "./notifications.css";

/**
 * Notifications (UI spec 16): the bell in the sidebar footer, its popover (last ten), the row
 * shared with the full page, and the computer's own notifications. The engine derives them from
 * the event stream; this file only shows them. Approvals offer "Review", never Approve.
 */

export const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  needs_you: Hand,
  update: CircleCheck,
  heads_up: CalendarClock,
  system: Info,
};

const KIND_WORD: Record<NotificationKind, string> = {
  needs_you: "Needs you",
  update: "Update",
  heads_up: "Heads-up",
  system: "Rocky",
};

export function notificationTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The list, kept fresh: refetched shortly after new events (the notifier ticks each second). */
export function useNotifications(tab: "all" | "needs_you" | "updates" = "all", limit = 100) {
  const qc = useQueryClient();
  const live = useLive();
  const lastSeq = live.events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastSeq) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: ["notifications"] }), 1500);
    return () => clearTimeout(t);
  }, [lastSeq, qc]);
  return useQuery({
    queryKey: ["notifications", tab, limit],
    queryFn: () => api.notifications(tab, limit),
    refetchInterval: 30_000,
  });
}

export function NotificationRow({
  n,
  onOpen,
}: {
  n: Notification;
  /** Called before following the link (marks it read, closes the popover). */
  onOpen: (n: Notification) => void;
}) {
  const Icon = KIND_ICON[n.kind];
  return (
    <li className="rk-notif" data-kind={n.kind} data-unread={n.readAt === null}>
      <Icon size={20} strokeWidth={1.5} aria-hidden className="rk-notif__icon" />
      <div className="rk-notif__main">
        <p className="rk-notif__sentence">
          {n.readAt === null && <span className="sr-only">Unread. </span>}
          <span className="sr-only">{KIND_WORD[n.kind]}: </span>
          {n.sentence}
        </p>
        <time className="rk-small rk-muted" dateTime={new Date(n.at).toISOString()}>
          {notificationTime(n.at)}
        </time>
      </div>
      {n.link && (
        <Link
          to={n.link}
          className="rk-button rk-button--secondary rk-button--dense"
          onClick={() => onOpen(n)}
          aria-label={`${n.actionLabel}: ${n.sentence}`}
        >
          {n.actionLabel}
        </Link>
      )}
      {n.kind === "heads_up" && <NotUseful n={n} />}
      {n.readAt === null && <span className="rk-notif__dot" aria-hidden="true" />}
    </li>
  );
}

/** Heads-ups only (roadmap A7, D-067): dismissing one lowers the score of it and similar ones. */
function NotUseful({ n }: { n: Notification }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <IconButton
      label="Not useful"
      dense
      onClick={() =>
        void api
          .dismissNotifications([n.id])
          .then(() => {
            toast({ text: "Dismissed. Rocky will nudge you less about things like this." });
            return qc.invalidateQueries({ queryKey: ["notifications"] });
          })
          .catch((e: unknown) =>
            toast({ text: `Not dismissed: ${e instanceof Error ? e.message : String(e)}` }),
          )
      }
    >
      <ThumbsDown size={16} strokeWidth={1.5} aria-hidden />
    </IconButton>
  );
}

export function useMarkRead() {
  const qc = useQueryClient();
  return (n: Notification) => {
    if (n.readAt !== null) return;
    void api
      .readNotifications([n.id])
      .then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
  };
}

/** Sidebar footer bell: unread count and a popover with the last ten. */
export function NotificationBell({ rail }: { rail: boolean }) {
  const list = useNotifications("all", 10);
  const markRead = useMarkRead();
  const qc = useQueryClient();
  const unread = list.data?.unread ?? 0;
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Popover
      title="Notifications"
      trigger={(p) => (
        <button type="button" className="rk-nav" aria-label={rail ? label : undefined} {...p}>
          <Bell size={20} strokeWidth={1.5} aria-hidden />
          {!rail && "Notifications"}
          {unread > 0 && (
            <span className="rk-nav__badge">
              {unread}
              <span className="sr-only"> unread</span>
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="rk-notif-pop">
          {list.isPending ? (
            <Skeleton rows={3} />
          ) : list.isError ? (
            <p className="rk-muted">Notifications didn't load. Rocky's engine may be down.</p>
          ) : list.data.notifications.length === 0 ? (
            <p className="rk-muted" style={{ margin: 0 }}>
              You're caught up.
            </p>
          ) : (
            <ul className="rk-notif-list">
              {list.data.notifications.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onOpen={(x) => {
                    markRead(x);
                    close();
                  }}
                />
              ))}
            </ul>
          )}
          <div className="rk-notif-pop__foot">
            <Button
              variant="tertiary"
              dense
              disabled={!unread}
              onClick={() =>
                void api
                  .readAllNotifications()
                  .then(() => qc.invalidateQueries({ queryKey: ["notifications"] }))
              }
            >
              Mark all as read
            </Button>
            <Link
              to="/notifications"
              className="rk-button rk-button--tertiary rk-button--dense"
              onClick={close}
            >
              See all
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Empty page state, shared by the page tabs. */
export function CaughtUp() {
  return (
    <EmptyState headline="You're caught up.">
      Rocky will tell you here when something needs you.
    </EmptyState>
  );
}

// --- The computer's own notifications ---

export type Permission = NotificationPermission | "unsupported";

export function systemPermission(): Permission {
  return typeof window !== "undefined" && "Notification" in window
    ? window.Notification.permission
    : "unsupported";
}

/** Shows one OS notification; clicking it brings the app forward at the item. */
export function showSystemNotification(
  n: Pick<Notification, "id" | "sentence" | "link" | "kind">,
  go: (link: string) => void,
): boolean {
  if (systemPermission() !== "granted") return false;
  try {
    const shown = new window.Notification(n.kind === "needs_you" ? "Rocky needs you" : "Rocky", {
      body: n.sentence,
      tag: n.id,
    });
    shown.onclick = () => {
      window.focus();
      if (n.link) go(n.link);
      shown.close();
    };
    return true;
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app record stays.
    return false;
  }
}

/**
 * Mounted once in the shell. New notifications that the preferences send to "this computer" are
 * shown as OS notifications while the app is in the background, except in quiet hours. Starts
 * from what is already there, so opening the app never replays old ones.
 */
export function useSystemNotifications(prefs: NotificationPrefs | undefined) {
  const list = useNotifications("all", 20);
  const navigate = useNavigate();
  const newest = useRef<string | null>(null);
  useEffect(() => {
    const rows = list.data?.notifications;
    if (!rows || !prefs) return;
    const top = rows[0]?.id ?? "";
    if (newest.current === null) {
      newest.current = top;
      return;
    }
    const fresh = rows.filter((n) => n.id > (newest.current ?? "") && n.readAt === null);
    if (top > newest.current) newest.current = top;
    if (!fresh.length || document.hasFocus() || inQuietHours(prefs.quietHours, new Date())) return;
    for (const n of fresh.reverse()) {
      if (channelTakes(prefs.system, n.kind))
        showSystemNotification(n, (link) => void navigate({ to: link }));
    }
  }, [list.data, prefs, navigate]);
}

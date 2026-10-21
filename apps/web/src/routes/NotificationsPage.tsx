import type { ChannelPrefs, Notification, NotificationPrefs } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Settings } from "../api.ts";
import {
  CaughtUp,
  NotificationRow,
  type Permission,
  showSystemNotification,
  systemPermission,
  useMarkRead,
  useNotifications,
} from "../notifications.tsx";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Input,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

/**
 * Notifications (UI spec 16): tabs Needs you, Updates, All, and Preferences. Needs you sits above
 * everything; the rest is grouped by day. Approvals offer "Review" only. Quiet hours silence the
 * computer's and the phone's notifications, never the record kept here.
 */

type Tab = "needs_you" | "updates" | "all" | "preferences";
const TABS: Tab[] = ["needs_you", "updates", "all", "preferences"];

export function NotificationsPage() {
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const tab: Tab = TABS.includes(search.tab as Tab) ? (search.tab as Tab) : "needs_you";
  const qc = useQueryClient();
  const toast = useToast();
  const all = useNotifications("all", 200);
  const readAll = useMutation({
    mutationFn: api.readAllNotifications,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      toast({ text: r.changed ? `Marked ${r.changed} as read.` : "Nothing was unread." });
    },
  });
  const unread = all.data?.unread ?? 0;
  const needs = all.data?.notifications.filter((n) => n.kind === "needs_you") ?? [];
  const updates = all.data?.notifications.filter((n) => n.kind !== "needs_you") ?? [];

  const body = (rows: Notification[], grouped: boolean) =>
    all.isPending ? (
      <Skeleton rows={4} />
    ) : all.isError ? (
      <ErrorState
        title="Notifications didn't load."
        happened="Rocky's engine didn't answer."
        fix={<Button onClick={() => void all.refetch()}>Retry</Button>}
      />
    ) : rows.length === 0 ? (
      <CaughtUp />
    ) : (
      <List rows={rows} grouped={grouped} />
    );

  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">Notifications</h1>
        <span style={{ flex: 1 }} />
        <Button
          variant="primary"
          disabled={!unread}
          loading={readAll.isPending && "Marking…"}
          onClick={() => readAll.mutate()}
        >
          Mark all as read
        </Button>
      </header>
      <Tabs
        label="Notifications"
        value={tab}
        onChange={(t) => void navigate({ to: "/notifications", search: { tab: t }, replace: true })}
        tabs={[
          {
            id: "needs_you",
            title: needs.length ? `Needs you (${needs.length})` : "Needs you",
            panel: body(needs, false),
          },
          { id: "updates", title: "Updates", panel: body(updates, true) },
          {
            id: "all",
            title: "All",
            panel: body([...needs, ...updates], true),
          },
          { id: "preferences", title: "Preferences", panel: <Preferences /> },
        ]}
      />
    </div>
  );
}

function dayLabel(at: number, now = new Date()): string {
  const d = new Date(at);
  const days = Math.round(
    (new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function List({ rows, grouped }: { rows: Notification[]; grouped: boolean }) {
  const markRead = useMarkRead();
  if (!grouped)
    return (
      <ul className="rk-notif-list">
        {rows.map((n) => (
          <NotificationRow key={n.id} n={n} onOpen={markRead} />
        ))}
      </ul>
    );
  const groups = new Map<string, Notification[]>();
  for (const n of [...rows].sort((a, b) => b.at - a.at)) {
    const k = dayLabel(n.at);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return (
    <>
      {[...groups].map(([day, list]) => (
        <section key={day} aria-label={day}>
          <h2 className="rk-small rk-notif-day">{day}</h2>
          <ul className="rk-notif-list">
            {list.map((n) => (
              <NotificationRow key={n.id} n={n} onOpen={markRead} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const KINDS: { key: keyof ChannelPrefs; label: string; help: string }[] = [
  { key: "needsYou", label: "Needs you", help: "Approvals, failures and Rocky's own problems." },
  { key: "updates", label: "Updates", help: "Background work that finished." },
  { key: "headsUp", label: "Heads-ups", help: "Commitments coming due." },
];

function Preferences() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [permission, setPermission] = useState<Permission>(systemPermission);
  // Optimistic: the box changes at once; a failed save puts it back and says so.
  const save = useMutation({
    mutationFn: (notifications: NotificationPrefs) => api.saveSettings({ notifications }),
    onMutate: (notifications) => {
      const before = qc.getQueryData<Settings>(["settings"]);
      if (before) qc.setQueryData<Settings>(["settings"], { ...before, notifications });
      return { before };
    },
    onSuccess: (s) => {
      qc.setQueryData<Settings>(["settings"], (old) => (old ? { ...old, ...s } : s));
      toast({ text: "Saved." });
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(["settings"], ctx.before);
      toast({ text: `Not saved: ${e instanceof Error ? e.message : String(e)}` });
    },
  });
  if (settings.isPending) return <Skeleton rows={4} />;
  if (settings.isError)
    return (
      <ErrorState
        title="Preferences didn't load."
        happened="Rocky's engine didn't answer."
        fix={<Button onClick={() => void settings.refetch()}>Retry</Button>}
      />
    );
  const prefs = settings.data.notifications;
  const set = (next: NotificationPrefs) => save.mutate(next);
  const setChannel = (ch: "system" | "phone", key: keyof ChannelPrefs, v: boolean) =>
    set({ ...prefs, [ch]: { ...prefs[ch], [key]: v } });

  const ask = async () => {
    if (permission === "unsupported") return;
    setPermission(await window.Notification.requestPermission());
  };
  const test = () => {
    const ok = showSystemNotification(
      {
        id: `test-${Date.now()}`,
        kind: "system",
        sentence: "Notifications from Rocky work.",
        link: null,
      },
      () => {},
    );
    if (!ok) toast({ text: "This browser didn't show it. Check its notification settings." });
  };

  return (
    <div className="rk-notif-prefs">
      {permission === "denied" && (
        <Banner
          tone="warning"
          title="This computer blocks Rocky's notifications."
          actions={<Button onClick={test}>Send a test</Button>}
        >
          Allow notifications for this site in the browser's site settings (the icon left of the
          address), then send a test. Rocky keeps every notification here either way.
        </Banner>
      )}
      {permission === "default" && (
        <Banner
          tone="info"
          title="Rocky can't show notifications on this computer yet."
          actions={<Button onClick={() => void ask()}>Allow notifications</Button>}
        >
          The browser asks once. You can change it later in its site settings.
        </Banner>
      )}
      {permission === "granted" && (
        <p className="rk-small rk-muted">
          This computer shows Rocky's notifications while Rocky is open in the background.{" "}
          <Button variant="tertiary" dense onClick={test}>
            Send a test
          </Button>
        </p>
      )}

      <Card>
        <table className="rk-notif-matrix">
          <caption className="rk-h3">What reaches you where</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col" className="rk-notif-matrix__always">
                In Rocky
              </th>
              <th scope="col">This computer</th>
              <th scope="col">Phone</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k) => (
              <tr key={k.key}>
                <th scope="row">
                  {k.label}
                  <span className="rk-small rk-muted rk-block">{k.help}</span>
                </th>
                <td className="rk-notif-matrix__always">
                  <Checkbox
                    label={<span className="sr-only">{k.label} in Rocky: always</span>}
                    checked
                    disabled
                    onChange={() => {}}
                  />
                </td>
                <td>
                  <Checkbox
                    label={<span className="sr-only">{k.label} on this computer</span>}
                    checked={prefs.system[k.key]}
                    disabled={save.isPending}
                    onChange={(v) => setChannel("system", k.key, v)}
                  />
                </td>
                <td>
                  <Checkbox
                    label={<span className="sr-only">{k.label} on your phone</span>}
                    checked={prefs.phone[k.key]}
                    disabled={save.isPending}
                    onChange={(v) => setChannel("phone", k.key, v)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="rk-small rk-muted" style={{ margin: "var(--space-3) 0 0" }}>
          Approvals always say Review, never Approve, so a glance can't approve anything. No phone
          is connected yet; phone notifications start once one is.
        </p>
      </Card>

      <QuietHours prefs={prefs} saving={save.isPending} onSave={set} />
    </div>
  );
}

function QuietHours({
  prefs,
  saving,
  onSave,
}: {
  prefs: NotificationPrefs;
  saving: boolean;
  onSave: (p: NotificationPrefs) => void;
}) {
  const q = prefs.quietHours;
  const [start, setStart] = useState(q.start);
  const [end, setEnd] = useState(q.end);
  const valid = /^\d\d:\d\d$/.test(start) && /^\d\d:\d\d$/.test(end);
  return (
    <Card>
      <h3 className="rk-h3">Quiet hours</h3>
      <p className="rk-small rk-muted" style={{ marginTop: 0 }}>
        The computer and the phone stay silent; everything is still kept here.
      </p>
      <Switch
        label="Use quiet hours"
        checked={q.enabled}
        disabled={saving}
        onChange={(enabled) => onSave({ ...prefs, quietHours: { ...q, enabled } })}
      />
      <div className="rk-notif-quiet">
        <Input label="From" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <Input label="Until" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        <Button
          disabled={!valid || saving || (start === q.start && end === q.end)}
          onClick={() => onSave({ ...prefs, quietHours: { ...q, start, end } })}
        >
          Save times
        </Button>
      </div>
    </Card>
  );
}

// UI spec 16: notifications are derived from the event stream; approvals offer "Review" only.
import { channelTakes, inQuietHours, NotificationPrefsSchema } from "@rocky/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNotification,
  type Db,
  deriveNotification,
  dismissNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  Notifier,
  recordEvent,
  snoozeNotifications,
  unreadCount,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

let db: Db;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => db.close());

const base = { seq: 1, at: 1000, runId: "r1" };

describe("deriveNotification", () => {
  it("turns a proposal into needs-you with Review, never Approve", () => {
    const n = deriveNotification({
      ...base,
      kind: "approval",
      actionId: "a1",
      change: "proposed",
      title: "Draft a reply to Sam",
      risk: "low",
      review: "standard",
    });
    expect(n).toMatchObject({ kind: "needs_you", link: "/approvals", actionLabel: "Review" });
    expect(n?.sentence).toBe("Needs your approval: Draft a reply to Sam");
  });

  it("notifies finished and failed background work, not asks or finished syncs", () => {
    const status = (runKind: "routine" | "ask" | "sync", state: "completed" | "failed") =>
      deriveNotification({ ...base, kind: "status", runKind, state, title: "Routine: brief" });
    expect(status("routine", "completed")).toMatchObject({ kind: "update", link: "/runs/r1" });
    expect(status("routine", "failed")).toMatchObject({ kind: "needs_you" });
    expect(status("sync", "failed")).toMatchObject({ kind: "needs_you" });
    expect(status("sync", "completed")).toBeNull();
    expect(status("ask", "completed")).toBeNull();
    expect(status("ask", "failed")).toBeNull();
  });

  it("tells Rocky's own errors once, and leaves in-run errors to the failed status", () => {
    const err = (runId: string | null) =>
      deriveNotification({
        ...base,
        runId,
        kind: "error",
        code: "ROUTINE_PAUSED",
        message: "Paused.",
      });
    expect(err(null)).toMatchObject({ kind: "system", link: "/tasks/background" });
    expect(err("job1")).toBeNull();
  });

  it("ignores messages, receipts and memory events", () => {
    expect(deriveNotification({ ...base, kind: "message", role: "rocky", text: "hi" })).toBeNull();
    expect(
      deriveNotification({ ...base, kind: "memory", change: "learned", text: "x" }),
    ).toBeNull();
  });
});

describe("Notifier", () => {
  it("starts at the newest event, then derives each new one exactly once", () => {
    recordEvent(db, { kind: "error", runId: null, code: "OLD", message: "Before install." });
    const notifier = new Notifier({ db });
    expect(notifier.tick()).toEqual([]);
    recordEvent(db, { kind: "error", runId: null, code: "X", message: "Backup failed." });
    recordEvent(db, { kind: "message", runId: null, role: "rocky", text: "ignored" });
    const first = notifier.tick();
    expect(first.map((n) => n.sentence)).toEqual(["Backup failed."]);
    expect(notifier.tick()).toEqual([]);
    // A second notifier (a restart) resumes from the stored cursor.
    expect(new Notifier({ db }).tick()).toEqual([]);
  });

  it("hands each new notification to onNew", () => {
    const seen: string[] = [];
    const notifier = new Notifier({ db, onNew: (n) => seen.push(n.kind) });
    notifier.tick();
    recordEvent(db, {
      kind: "approval",
      runId: "a1",
      actionId: "a1",
      change: "proposed",
      title: "Create an event",
      risk: "medium",
      review: "standard",
    });
    notifier.tick();
    expect(seen).toEqual(["needs_you"]);
  });
});

describe("notification store", () => {
  const add = (kind: "needs_you" | "update", at: number) =>
    addNotification(
      db,
      { kind, sentence: `${kind} ${at}`, link: null, actionLabel: "Open", runId: null },
      at,
    );

  it("lists newest first by tab, with an unread count", () => {
    add("needs_you", 1000);
    add("update", 2000);
    expect(listNotifications(db).notifications.map((n) => n.sentence)).toEqual([
      "update 2000",
      "needs_you 1000",
    ]);
    expect(listNotifications(db, { tab: "needs_you" }).notifications).toHaveLength(1);
    expect(listNotifications(db, { tab: "updates" }).notifications).toHaveLength(1);
    expect(unreadCount(db)).toBe(2);
  });

  it("marks read, snoozes and dismisses", () => {
    const a = add("needs_you", 1000);
    const b = add("update", 2000);
    if (!a || !b) throw new Error("not stored");
    expect(markNotificationsRead(db, [a.id], 5000)).toBe(1);
    expect(unreadCount(db, 5000)).toBe(1);
    snoozeNotifications(db, [b.id], 10_000);
    expect(listNotifications(db, {}, 9000).notifications.map((n) => n.id)).toEqual([a.id]);
    expect(listNotifications(db, {}, 10_000).notifications).toHaveLength(2);
    dismissNotifications(db, [a.id]);
    expect(listNotifications(db, {}, 10_000).notifications.map((n) => n.id)).toEqual([b.id]);
    expect(markAllNotificationsRead(db)).toBe(1);
    expect(unreadCount(db, 10_000)).toBe(0);
  });
});

describe("preferences", () => {
  const prefs = NotificationPrefsSchema.parse({});

  it("defaults: needs-you and heads-ups reach channels, updates stay in the app", () => {
    expect(channelTakes(prefs.system, "needs_you")).toBe(true);
    expect(channelTakes(prefs.system, "system")).toBe(true);
    expect(channelTakes(prefs.system, "heads_up")).toBe(true);
    expect(channelTakes(prefs.system, "update")).toBe(false);
    expect(prefs.quietHours.enabled).toBe(false);
  });

  it("quiet hours work across midnight and within a day", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m);
    const night = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(6, 59))).toBe(true);
    expect(inQuietHours(night, at(7))).toBe(false);
    expect(inQuietHours(night, at(12))).toBe(false);
    const lunch = { enabled: true, start: "12:00", end: "13:00" };
    expect(inQuietHours(lunch, at(12, 30))).toBe(true);
    expect(inQuietHours(lunch, at(13))).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, at(23))).toBe(false);
  });
});

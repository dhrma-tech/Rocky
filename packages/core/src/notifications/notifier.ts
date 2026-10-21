import {
  type Notification,
  type NotificationKind,
  type NotificationList,
  type NotificationListQuery,
  NotificationListQuerySchema,
} from "@rocky/contracts";
import { ulid } from "ulid";
import { eventsAfter, lastEventSeq } from "../events/log.ts";
import type { Db } from "../store/db.ts";
import { type DerivedNotification, deriveNotification } from "./derive.ts";

/**
 * Notifications (UI spec 16). The notifier follows the event log with its own cursor, so events
 * written by the CLI notify too and nothing is derived twice across restarts. In-app always keeps
 * the record; channels (the computer's notifications, phones) get what the preferences allow.
 */

interface Row {
  id: string;
  at: number;
  kind: NotificationKind;
  sentence: string;
  link: string | null;
  action_label: string;
  run_id: string | null;
  read_at: number | null;
  snoozed_until: number | null;
}

const toNotification = (r: Row): Notification => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  sentence: r.sentence,
  link: r.link,
  actionLabel: r.action_label,
  runId: r.run_id,
  readAt: r.read_at,
  snoozedUntil: r.snoozed_until,
});

/** Store one notification. Notifications from outside the event log (A7 heads-ups) come here. */
export function addNotification(
  db: Db,
  n: DerivedNotification & { eventSeq?: number },
  at = Date.now(),
): Notification | null {
  const id = ulid(at);
  const info = db
    .prepare(
      `insert or ignore into notifications (id, at, kind, sentence, link, action_label, run_id, event_seq)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, at, n.kind, n.sentence, n.link, n.actionLabel, n.runId, n.eventSeq ?? null);
  if (!info.changes) return null;
  return toNotification(db.prepare("select * from notifications where id = ?").get(id) as Row);
}

const TABS: Record<string, NotificationKind[]> = {
  all: ["needs_you", "update", "heads_up", "system"],
  needs_you: ["needs_you"],
  updates: ["update", "heads_up", "system"],
};

/** Newest first. Dismissed rows are gone; snoozed ones come back when the snooze ends. */
export function listNotifications(
  db: Db,
  query: NotificationListQuery = {},
  now = Date.now(),
): NotificationList {
  const q = NotificationListQuerySchema.parse(query);
  const rows = db
    .prepare(
      `select * from notifications
       where dismissed_at is null and (snoozed_until is null or snoozed_until <= ?)
         and kind in (select value from json_each(?)) and id > ?
       order by id desc limit ?`,
    )
    .all(now, JSON.stringify(TABS[q.tab]), q.after ?? "", q.limit) as Row[];
  return { notifications: rows.map(toNotification), unread: unreadCount(db, now) };
}

export function unreadCount(db: Db, now = Date.now()): number {
  return (
    db
      .prepare(
        `select count(*) as n from notifications where read_at is null and dismissed_at is null
         and (snoozed_until is null or snoozed_until <= ?)`,
      )
      .get(now) as { n: number }
  ).n;
}

function updateMany(db: Db, sql: string, ids: string[], value: number): number {
  const stmt = db.prepare(sql);
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(value, id).changes, 0))();
}

export function markNotificationsRead(db: Db, ids: string[], now = Date.now()): number {
  return updateMany(
    db,
    "update notifications set read_at = ? where id = ? and read_at is null",
    ids,
    now,
  );
}

export function markAllNotificationsRead(db: Db, now = Date.now()): number {
  return db
    .prepare("update notifications set read_at = ? where read_at is null and dismissed_at is null")
    .run(now).changes;
}

export function snoozeNotifications(db: Db, ids: string[], until: number): number {
  return updateMany(db, "update notifications set snoozed_until = ? where id = ?", ids, until);
}

export function dismissNotifications(db: Db, ids: string[], now = Date.now()): number {
  return updateMany(
    db,
    "update notifications set dismissed_at = ? where id = ? and dismissed_at is null",
    ids,
    now,
  );
}

export function getNotification(db: Db, id: string): Notification | null {
  const r = db.prepare("select * from notifications where id = ?").get(id) as Row | undefined;
  return r ? toNotification(r) : null;
}

export interface NotifierOptions {
  db: Db;
  /** Called once per new notification, after it is stored (phone channels hook in here). */
  onNew?: (n: Notification) => void;
}

export class Notifier {
  private readonly db: Db;
  private readonly onNew: ((n: Notification) => void) | undefined;

  constructor(opts: NotifierOptions) {
    this.db = opts.db;
    this.onNew = opts.onNew;
  }

  /** Derive notifications from events since the cursor. The first run starts at the newest
   * event, so an existing install isn't flooded with its history. */
  tick(): Notification[] {
    const state = this.db.prepare("select last_seq from notifier_state where id = 1").get() as
      | { last_seq: number }
      | undefined;
    if (!state) {
      this.db
        .prepare("insert into notifier_state (id, last_seq) values (1, ?)")
        .run(lastEventSeq(this.db));
      return [];
    }
    const out: Notification[] = [];
    let last = state.last_seq;
    for (;;) {
      const batch = eventsAfter(this.db, last, { limit: 500 });
      if (!batch.length) break;
      this.db.transaction(() => {
        for (const e of batch) {
          const d = deriveNotification(e);
          if (d) {
            const n = addNotification(this.db, { ...d, eventSeq: e.seq }, e.at);
            if (n) out.push(n);
          }
          last = e.seq;
        }
        this.db.prepare("update notifier_state set last_seq = ? where id = 1").run(last);
      })();
      if (batch.length < 500) break;
    }
    for (const n of out) this.onNew?.(n);
    return out;
  }
}

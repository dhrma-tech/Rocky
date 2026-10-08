import { type RockyEvent, type RockyEventInput, RockyEventSchema } from "@rocky/contracts";
import type { Db } from "../store/db.ts";

/**
 * The event log behind the typed event stream (UI spec "Agent UI"). Emitters append; the daemon
 * streams rows after a client's last `seq`, so a reconnecting UI replays exactly what it missed.
 * Writes from other processes (the CLI) show up the same way, because readers poll the table.
 */

export function recordEvent(db: Db, e: RockyEventInput): RockyEvent {
  const at = e.at ?? Date.now();
  const { kind, runId, at: _at, ...rest } = e as RockyEventInput & Record<string, unknown>;
  const info = db
    .prepare("insert into events (at, kind, run_id, payload) values (?, ?, ?, ?)")
    .run(at, kind, runId, JSON.stringify(rest));
  return { ...rest, kind, runId, at, seq: Number(info.lastInsertRowid) } as RockyEvent;
}

interface Row {
  seq: number;
  at: number;
  kind: string;
  run_id: string | null;
  payload: string;
}

/** Events after `after` (exclusive), oldest first. Rows that no longer parse are skipped. */
export function eventsAfter(
  db: Db,
  after: number,
  opts: { limit?: number; runId?: string } = {},
): RockyEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const rows = (
    opts.runId
      ? db
          .prepare("select * from events where seq > ? and run_id = ? order by seq limit ?")
          .all(after, opts.runId, limit)
      : db.prepare("select * from events where seq > ? order by seq limit ?").all(after, limit)
  ) as Row[];
  return rows.flatMap((r) => {
    const parsed = RockyEventSchema.safeParse({
      ...(JSON.parse(r.payload) as object),
      seq: r.seq,
      at: r.at,
      kind: r.kind,
      runId: r.run_id,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

export function lastEventSeq(db: Db): number {
  return (db.prepare("select coalesce(max(seq), 0) as n from events").get() as { n: number }).n;
}

/** The newest `n` events, oldest first (a screen's starting point before it follows the stream). */
export function recentEvents(db: Db, n: number): RockyEvent[] {
  const limit = Math.min(Math.max(n, 1), 5000);
  const first = (
    db.prepare("select seq from events order by seq desc limit 1 offset ?").get(limit - 1) as
      | { seq: number }
      | undefined
  )?.seq;
  return eventsAfter(db, first === undefined ? 0 : first - 1, { limit });
}

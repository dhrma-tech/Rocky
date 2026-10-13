import {
  type AgentState,
  type RockyEvent,
  type RunHistoryQuery,
  RunHistoryQuerySchema,
  type RunSummary,
} from "@rocky/contracts";
import type { Db } from "../store/db.ts";
import { parseEventRow } from "./log.ts";

/**
 * Task history (UI spec 10): every run folded from its events, newest first. The events stay
 * append-only; archiving only hides a run here (`run_archive`), and Undo brings it back.
 */

/** How many recent runs a search looks through. A local store; folding them is cheap. */
const SCAN = 2000;

export function receiptLine(e: Extract<RockyEvent, { kind: "receipt" }>): string {
  const unit = e.count === 1 || e.unit.endsWith("s") ? e.unit : `${e.unit}s`;
  return `${e.tool} → ${e.verb} ${e.count} ${unit}${e.notDone ? ` · ${e.notDone}` : ""}`;
}

function fold(id: string, events: RockyEvent[]): Omit<RunSummary, "archived" | "routineId"> {
  const first = events[0] as RockyEvent;
  const run: Omit<RunSummary, "archived" | "routineId"> = {
    id,
    kind: "job",
    title: "Run",
    state: "thinking",
    startedAt: first.at,
    updatedAt: first.at,
    receipts: 0,
    outcome: null,
  };
  for (const e of events) {
    run.updatedAt = e.at;
    switch (e.kind) {
      case "status":
        run.kind = e.runKind;
        run.title = e.title;
        run.state = e.state;
        break;
      case "receipt":
        run.receipts++;
        run.outcome = receiptLine(e);
        break;
      case "approval": {
        run.kind = "action";
        run.title = e.title;
        const map: Record<typeof e.change, AgentState> = {
          proposed: "needs_approval",
          edited: "needs_approval",
          revoked: "needs_approval",
          approved: "waiting",
          executed: "completed",
          rejected: "completed",
          blocked: "completed",
          failed: "failed",
        };
        run.state = map[e.change] ?? run.state;
        if (e.change === "rejected" || e.change === "blocked")
          run.outcome = `${e.change}: nothing ran`;
        break;
      }
      case "error":
        run.state = "failed";
        run.outcome = e.message;
        break;
      default:
        break;
    }
  }
  return run;
}

const STATES: Record<string, AgentState[] | null> = {
  all: null,
  active: ["thinking", "working", "browsing", "using_tool", "waiting", "background"],
  needs_you: ["needs_approval"],
  done: ["completed"],
  failed: ["failed"],
};

export function listRuns(db: Db, query: RunHistoryQuery = {}): RunSummary[] {
  const q = RunHistoryQuerySchema.parse(query);
  const ids = db
    .prepare(
      `select e.run_id as id, max(e.at) as last, (a.run_id is not null) as archived
       from events e left join run_archive a on a.run_id = e.run_id
       where e.run_id is not null
       group by e.run_id
       having last >= ? and last <= ? and archived = ?
       order by last desc limit ?`,
    )
    .all(q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER, q.archived ? 1 : 0, SCAN) as {
    id: string;
  }[];
  if (!ids.length) return [];
  const byRun = new Map<string, RockyEvent[]>();
  const rows = db
    .prepare(`select * from events where run_id in (select value from json_each(?)) order by seq`)
    .all(JSON.stringify(ids.map((r) => r.id)));
  for (const row of rows) {
    const e = parseEventRow(row);
    if (!e?.runId) continue;
    const list = byRun.get(e.runId) ?? [];
    list.push(e);
    byRun.set(e.runId, list);
  }
  const routineOf = db.prepare(
    "select json_extract(payload, '$.routineId') as r from jobs where id = ? and type = 'routine'",
  );
  const states = STATES[q.status];
  const needle = q.q?.toLowerCase();
  const out: RunSummary[] = [];
  for (const { id } of ids) {
    const events = byRun.get(id);
    if (!events?.length) continue;
    const run = fold(id, events);
    if (states && !states.includes(run.state)) continue;
    if (
      needle &&
      !run.title.toLowerCase().includes(needle) &&
      !(run.outcome ?? "").toLowerCase().includes(needle)
    )
      continue;
    const routine =
      run.kind === "routine" ? (routineOf.get(id) as { r: string | null } | undefined) : undefined;
    out.push({ ...run, archived: q.archived, routineId: routine?.r ?? null });
    if (out.length >= q.limit) break;
  }
  return out;
}

export function archiveRuns(db: Db, ids: string[], now = Date.now()): number {
  const insert = db.prepare(
    "insert or ignore into run_archive (run_id, archived_at) values (?, ?)",
  );
  return db.transaction(() => ids.reduce((n, id) => n + insert.run(id, now).changes, 0))();
}

export function unarchiveRuns(db: Db, ids: string[]): number {
  const del = db.prepare("delete from run_archive where run_id = ?");
  return db.transaction(() => ids.reduce((n, id) => n + del.run(id).changes, 0))();
}

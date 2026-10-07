import type { HomeSummary } from "@rocky/contracts";
import { listCommitments } from "../capture/queries.ts";
import type { Db } from "../store/db.ts";
import { latestRun } from "./routines.ts";
import { dayRange, timeline } from "./timeline.ts";

const DAY = 86_400_000;

/** GET /home (DESIGN screen 1): today, commitments due soon or overdue, approvals, last routine run. */
export function home(db: Db, now = Date.now()): HomeSummary {
  return {
    today: timeline(db, dayRange(now)),
    dueSoon: listCommitments(db, { status: "open", dueAfter: now, dueBefore: now + 7 * DAY }),
    overdue: listCommitments(db, { status: "open", dueBefore: now }),
    pendingApprovals: (
      db.prepare("select count(*) as n from actions_queue where status = 'draft'").get() as {
        n: number;
      }
    ).n,
    lastRun: latestRun(db),
  };
}

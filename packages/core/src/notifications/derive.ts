import type { NotificationKind, RockyEvent } from "@rocky/contracts";

/**
 * Which events become notifications (UI spec 16, spec "Background": notify only needs-you, done
 * and failed). Pure, so the rules are tested without a store. Asks are left out: the user is
 * watching them. Syncs notify only when they fail; a finished sync is noise.
 */

export interface DerivedNotification {
  kind: NotificationKind;
  sentence: string;
  link: string | null;
  actionLabel: string;
  runId: string | null;
}

const run = (id: string | null) => (id ? `/runs/${id}` : "/ledger");

export function deriveNotification(e: RockyEvent): DerivedNotification | null {
  switch (e.kind) {
    case "approval":
      switch (e.change) {
        case "proposed":
          // "Review" only: a glance at a notification can never approve (UI spec 16, D-002).
          return {
            kind: "needs_you",
            sentence: `Needs your approval: ${e.title}`,
            link: "/approvals",
            actionLabel: "Review",
            runId: e.runId,
          };
        case "executed":
          return {
            kind: "update",
            sentence: `Done: ${e.title}`,
            link: run(e.runId),
            actionLabel: "Open",
            runId: e.runId,
          };
        case "failed":
          return {
            kind: "needs_you",
            sentence: `Couldn't finish: ${e.title}`,
            link: run(e.runId),
            actionLabel: "Open",
            runId: e.runId,
          };
        case "blocked":
          return {
            kind: "update",
            sentence: `Blocked by your rule: ${e.title}`,
            link: run(e.runId),
            actionLabel: "Open",
            runId: e.runId,
          };
        default:
          return null;
      }
    case "status":
      if (e.runKind === "ask" || e.runKind === "action") return null;
      if (e.state === "failed")
        return {
          kind: "needs_you",
          sentence: `${e.title} failed.`,
          link: run(e.runId),
          actionLabel: "Open",
          runId: e.runId,
        };
      if (e.state === "completed" && e.runKind !== "sync")
        return {
          kind: "update",
          sentence: `${e.title} finished.`,
          link: run(e.runId),
          actionLabel: "Open",
          runId: e.runId,
        };
      return null;
    case "error":
      // Errors inside a run are told by its "failed" status; these are Rocky's own (a routine
      // paused itself, a backup failed).
      if (e.runId) return null;
      return {
        kind: "system",
        sentence: e.message,
        link: e.code === "ROUTINE_PAUSED" ? "/tasks/background" : "/ledger",
        actionLabel: "Open",
        runId: null,
      };
    default:
      return null;
  }
}

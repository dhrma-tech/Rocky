import type { RockyEvent } from "@rocky/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useLive, useNow } from "../agent-ui/live.tsx";
import { elapsed, foldRuns } from "../agent-ui/runs.ts";
import { StatusChip } from "../agent-ui/StatusChip.tsx";
import { STATUS } from "../agent-ui/status.ts";
import { Receipt, Timeline } from "../agent-ui/work.tsx";
import { api } from "../api.ts";
import { Button, Card, ErrorState, Skeleton, useKeys, useToast } from "../ui/index.tsx";
import "./screens.css";

/**
 * One run (UI spec 7): status and what it is doing now, then the steps, then receipts, then raw
 * detail. A run is an engine unit (job, sync, action; D-017). Pause and Stop appear once the engine
 * can pause or stop that kind of run; today none can, so they are not shown.
 */
export function RunPage() {
  const { id } = useParams({ from: "/runs/$id" });
  const live = useLive();
  const now = useNow();
  const toast = useToast();
  const [selected, setSelected] = useState(-1);
  // Older runs are not in the live window: read their events directly.
  const history = useQuery({
    queryKey: ["run-events", id],
    queryFn: () => api.eventsPage(0, { runId: id, limit: 2000 }),
    enabled: !live.loading && !live.runs.has(id),
  });
  const run = useMemo(
    () => live.runs.get(id) ?? (history.data ? foldRuns(history.data.events).get(id) : undefined),
    [live.runs, history.data, id],
  );
  const events: RockyEvent[] = useMemo(
    () =>
      live.runs.has(id) ? live.events.filter((e) => e.runId === id) : (history.data?.events ?? []),
    [live.events, live.runs, history.data, id],
  );

  const stepCount = run?.steps.length ?? 0;
  useKeys((key, e) => {
    if (key !== "j" && key !== "k") return;
    e.preventDefault();
    const next = Math.max(0, Math.min(stepCount - 1, selected + (key === "j" ? 1 : -1)));
    setSelected(next);
    document.querySelectorAll<HTMLButtonElement>(".rk-step-btn")[next]?.focus();
  });

  if (live.loading || history.isLoading)
    return (
      <div className="rk-page">
        <p className="rk-muted">Planning</p>
        <Skeleton rows={4} height={44} label="Loading the run" />
      </div>
    );
  if (!run)
    return (
      <div className="rk-page">
        <ErrorState
          title="This run isn't in the ledger."
          happened={history.error ? history.error.message : `No events were recorded for ${id}.`}
          fix={
            <Link to="/tasks" className="rk-button rk-button--secondary">
              Back to Tasks
            </Link>
          }
        />
      </div>
    );

  const done = run.state === "completed" || run.state === "failed";
  const step = run.steps[selected] ?? null;
  const detail = step ? events.find((e) => e.seq === step.seq) : null;
  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">{run.title}</h1>
        <StatusChip state={run.state} {...(run.step ? { detail: { step: run.step } } : {})} />
        <span className="rk-small rk-muted">
          {done
            ? `${STATUS[run.state].word} in ${elapsed(run.updatedAt - run.startedAt)}`
            : `${elapsed(now - run.startedAt)} so far`}
        </span>
        {run.kind === "action" && run.state === "needs_approval" && (
          <Link to="/approvals" className="rk-button rk-button--primary">
            Review
          </Link>
        )}
        <Button
          variant="tertiary"
          onClick={() => {
            void navigator.clipboard?.writeText(location.href);
            toast({ text: "Link copied." });
          }}
        >
          Copy link
        </Button>
      </header>
      {run.line && <p style={{ marginTop: 0 }}>{run.line}</p>}

      <div className="rk-run">
        <section aria-label="Steps">
          <h2 className="rk-h2">Steps</h2>
          <p className="rk-small rk-muted">Select a step to see its detail · J and K to move</p>
          <Timeline steps={run.steps} selected={selected} onSelect={setSelected} />
          {run.receipts.length > 0 && (
            <>
              <h2 className="rk-h2">Receipts</h2>
              <ul className="rk-list">
                {run.receipts.map((r) => (
                  <li key={r.seq}>
                    <Receipt
                      event={r}
                      onOpen={() => setSelected(run.steps.findIndex((s) => s.seq === r.seq))}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <Card as="section" aria-label="Step detail" className="rk-detail">
          <h2 className="rk-h3">Detail</h2>
          {detail ? (
            <pre className="rk-mono">{JSON.stringify(detail, null, 2)}</pre>
          ) : (
            <p className="rk-muted">Select a step to see the event behind it.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

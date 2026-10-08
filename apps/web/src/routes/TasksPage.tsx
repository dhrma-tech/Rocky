import { Link } from "@tanstack/react-router";
import { useLive, useNow } from "../agent-ui/live.tsx";
import { activeRuns, finishedSince } from "../agent-ui/runs.ts";
import { TaskCard } from "../agent-ui/work.tsx";
import { EmptyState, ErrorState, Skeleton } from "../ui/index.tsx";
import "./screens.css";

/**
 * Tasks (P1): what is running and what finished in the last day, from the live event stream.
 * The full history table, filters and Background routines arrive with screens 10 and 11 (P2).
 */
export function TasksPage() {
  const live = useLive();
  const now = useNow();
  const running = activeRuns(live.runs);
  const finished = finishedSince(live.runs, now - 86_400_000);
  const open = (id: string) => (
    <Link
      to="/runs/$id"
      params={{ id }}
      className="rk-button rk-button--secondary rk-button--dense"
    >
      Open
    </Link>
  );
  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">Tasks</h1>
        <Link to="/routines" className="rk-button rk-button--secondary">
          Routines
        </Link>
      </header>
      {live.loading && <Skeleton rows={3} height={120} label="Loading tasks" />}
      {live.error && (
        <ErrorState
          title="Couldn't read the tasks."
          happened={live.error.message}
          rockyDid="Nothing was changed."
        />
      )}
      {!live.loading && !live.error && running.length + finished.length === 0 && (
        <EmptyState
          headline="No tasks yet."
          action={
            <Link to="/routines" className="rk-button rk-button--primary">
              Set up a routine
            </Link>
          }
        >
          Syncs, routines, transcriptions and approved actions show up here as they run.
        </EmptyState>
      )}
      {running.length > 0 && (
        <section className="rk-section" aria-labelledby="t-running">
          <h2 id="t-running" className="rk-h2">
            Running
          </h2>
          {running.map((r) => (
            <TaskCard key={r.id} run={r} now={now} action={open(r.id)} />
          ))}
        </section>
      )}
      {finished.length > 0 && (
        <section className="rk-section" aria-labelledby="t-done">
          <h2 id="t-done" className="rk-h2">
            Finished in the last day
          </h2>
          {finished.map((r) => (
            <TaskCard key={r.id} run={r} now={now} action={open(r.id)} />
          ))}
        </section>
      )}
    </div>
  );
}

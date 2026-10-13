import type { Citation, Routine, RoutineRun } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pause, Play, Plus } from "lucide-react";
import { useState } from "react";
import { useLive, useNow } from "../agent-ui/live.tsx";
import { activeRuns, type RunView } from "../agent-ui/runs.ts";
import { TaskCard } from "../agent-ui/work.tsx";
import { assistant } from "../api.ts";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { scheduleLabel } from "../routines.ts";
import {
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Modal,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "../ui/index.tsx";
import { AddRoutine, RoutineDetail } from "./RoutineEditor.tsx";
import "./screens.css";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const WORD: Record<RoutineRun["status"], string> = {
  done: "done",
  failed: "failed",
  running: "running",
};

/**
 * Background (UI spec 11): what runs while you're away and the controls to keep it in check.
 * Stuck first (routines that paused themselves), then three tabs: Running, Scheduled, Paused or
 * waiting. Cards open the run or the routine's settings in a drawer.
 */
export function BackgroundPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const live = useLive();
  const now = useNow();
  const list = useQuery({
    queryKey: ["routines"],
    queryFn: assistant.routines,
    refetchInterval: 30_000,
  });
  const [tab, setTab] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["routines"] });

  const resume = (ids: string[]) =>
    Promise.all(ids.map((id) => assistant.updateRoutine(id, { enabled: true }))).finally(refresh);
  const pauseAll = useMutation({
    mutationFn: assistant.pauseAllRoutines,
    onSuccess: ({ paused }) => {
      setConfirmPause(false);
      refresh();
      toast({
        text: `Paused ${paused.length} routine${paused.length === 1 ? "" : "s"}.`,
        action: { label: "Undo", run: () => void resume(paused) },
      });
    },
  });

  const routines = list.data?.routines ?? [];
  const stuck = routines.filter((r) => r.autoPaused);
  const scheduled = routines
    .filter((r) => r.enabled)
    .sort(
      (a, b) =>
        Number(b.lastRun?.status === "failed") - Number(a.lastRun?.status === "failed") ||
        (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
    );
  const paused = routines.filter((r) => !r.enabled && !r.autoPaused);
  const running = activeRuns(live.runs).filter((r) => r.state !== "waiting");
  const waiting = [...live.runs.values()]
    .filter((r) => r.state === "waiting" || r.state === "needs_approval")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const current = tab ?? (waiting.length ? "waiting" : running.length ? "running" : "scheduled");

  const head = (
    <header className="rk-page__head">
      <h1 className="rk-title">Background</h1>
      <Link to="/tasks" className="rk-small">
        All tasks
      </Link>
      <span style={{ flex: 1 }} />
      <Button
        disabled={!scheduled.length}
        icon={<Pause size={16} strokeWidth={1.5} aria-hidden />}
        onClick={() => setConfirmPause(true)}
      >
        Pause all
      </Button>
      <Button
        variant="primary"
        icon={<Plus size={16} strokeWidth={1.5} aria-hidden />}
        onClick={() => setEditing("new")}
      >
        New routine
      </Button>
    </header>
  );

  let body: React.ReactNode;
  if (list.isLoading) body = <Skeleton rows={3} height={148} label="Loading background tasks" />;
  else if (list.error)
    body = (
      <ErrorState
        title="Couldn't read your routines."
        happened={list.error.message}
        rockyDid="Nothing was changed. Scheduled routines keep running."
        fix={
          <Button variant="primary" onClick={refresh}>
            Retry
          </Button>
        }
      />
    );
  else if (!routines.length && !running.length && !waiting.length)
    body = <Empty onAdded={setEditing} onNew={() => setEditing("new")} />;
  else {
    const cards = (rs: Routine[], empty: string) =>
      rs.length ? (
        <ul className="rk-routines">
          {rs.map((r) => (
            <RoutineCard key={r.id} routine={r} onEdit={() => setEditing(r.id)} />
          ))}
        </ul>
      ) : (
        <p className="rk-muted">{empty}</p>
      );
    const runs = (rs: RunView[], empty: string) =>
      rs.length ? (
        <div className="rk-section">
          {rs.map((r) => (
            <TaskCard
              key={r.id}
              run={r}
              now={now}
              action={
                r.state === "needs_approval" ? (
                  <Link to="/approvals" className="rk-button rk-button--secondary rk-button--dense">
                    Review
                  </Link>
                ) : (
                  <Link
                    to="/runs/$id"
                    params={{ id: r.id }}
                    className="rk-button rk-button--secondary rk-button--dense"
                  >
                    Open
                  </Link>
                )
              }
            />
          ))}
        </div>
      ) : (
        <p className="rk-muted">{empty}</p>
      );
    body = (
      <>
        {stuck.length > 0 && (
          <section className="rk-section" aria-labelledby="bg-stuck">
            <h2 id="bg-stuck" className="rk-h2">
              Paused after failing
            </h2>
            {cards(stuck, "")}
          </section>
        )}
        <Tabs
          label="Background tasks"
          value={current}
          onChange={setTab}
          tabs={[
            {
              id: "running",
              title: `Running (${running.length})`,
              panel: runs(running, "Nothing is running right now."),
            },
            {
              id: "scheduled",
              title: `Scheduled (${scheduled.length})`,
              panel: cards(scheduled, "No routine is switched on."),
            },
            {
              id: "waiting",
              title: `Paused or waiting (${paused.length + waiting.length})`,
              panel: (
                <>
                  {waiting.length > 0 && runs(waiting, "")}
                  {cards(paused, waiting.length ? "" : "Nothing is paused or waiting.")}
                </>
              ),
            },
          ]}
        />
      </>
    );
  }

  return (
    <div className="rk-page rk-page--wide">
      {head}
      <p className="rk-muted" style={{ marginTop: 0, marginBottom: "var(--space-6)" }}>
        Routines write cited summaries from your own sources. They never send or change anything. A
        run missed while this computer slept runs once when it wakes.
      </p>
      {body}
      <EditDrawer
        id={editing}
        routines={routines}
        onClose={() => setEditing(null)}
        onPick={setEditing}
      />
      <Modal
        open={confirmPause}
        onClose={() => setConfirmPause(false)}
        title="Pause every routine?"
        actions={
          <>
            <Button variant="tertiary" onClick={() => setConfirmPause(false)}>
              Keep them running
            </Button>
            <Button
              variant="primary"
              loading={pauseAll.isPending && "Pausing…"}
              onClick={() => pauseAll.mutate()}
            >
              Pause all
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          {scheduled.length} routine{scheduled.length === 1 ? "" : "s"} stop until you resume them.
          A run that already started finishes.
        </p>
        {pauseAll.error && (
          <p role="alert" className="rk-small" style={{ color: "var(--color-error-text)" }}>
            {pauseAll.error.message}
          </p>
        )}
      </Modal>
    </div>
  );
}

/** Routine card (UI spec 11): name, schedule in words, next run, last result, health strip. */
function RoutineCard({ routine: r, onEdit }: { routine: Routine; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["routines"] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => assistant.updateRoutine(r.id, { enabled }),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: () => assistant.runRoutine(r.id),
    onSuccess: () => {
      toast({ text: `${r.name} is queued. Local models can take a few minutes.` });
      refresh();
    },
  });
  const last = r.lastRun;
  const failing = r.autoPaused || last?.status === "failed";
  return (
    <Card as="li" className={`rk-routine${failing ? " rk-routine--warn" : ""}`}>
      <div className="rk-task__head">
        <h3 className="rk-h3 rk-task__title">{r.name}</h3>
        <Switch
          label={r.enabled ? "On" : "Paused"}
          checked={r.enabled}
          disabled={toggle.isPending}
          onChange={(on) => toggle.mutate(on)}
        />
      </div>
      <p className="rk-small" style={{ margin: 0 }}>
        {scheduleLabel(r.schedule)}
        <span className="rk-muted">
          {" · "}
          {r.enabled && r.nextRunAt ? `next ${when(r.nextRunAt)}` : "paused"}
        </span>
      </p>
      <Health recent={r.recent} />
      <p className="rk-small" style={{ margin: 0 }}>
        {r.autoPaused ? <strong>Failed 3 times in a row, so Rocky paused it. </strong> : null}
        {!last
          ? "Hasn't run yet."
          : last.status === "running"
            ? `Running since ${when(last.startedAt)}.`
            : last.status === "failed"
              ? `Last run ${when(last.startedAt)} failed: ${last.error ?? "no reason recorded"}`
              : last.notFound
                ? `Last run ${when(last.startedAt)}: nothing to report from your sources.`
                : `Last run ${when(last.startedAt)}: ${last.answer.length} cited sentence${last.answer.length === 1 ? "" : "s"}.`}
      </p>
      {(toggle.error ?? run.error) && (
        <p role="alert" className="rk-small" style={{ margin: 0 }}>
          {(toggle.error ?? run.error)?.message}
        </p>
      )}
      <div className="rk-routine__actions">
        <Button dense onClick={onEdit} aria-label={`${failing ? "Fix" : "Edit"}: ${r.name}`}>
          {failing ? "Fix" : "Edit"}
        </Button>
        <Button
          dense
          loading={run.isPending && "Queuing…"}
          icon={<Play size={16} strokeWidth={1.5} aria-hidden />}
          onClick={() => run.mutate()}
          aria-label={`Run now: ${r.name}`}
        >
          Run now
        </Button>
      </div>
    </Card>
  );
}

/** The last five runs, oldest to newest; one line at every width. Never colour alone. */
function Health({ recent }: { recent: RoutineRun["status"][] }) {
  const slots = [...recent].reverse();
  while (slots.length < 5) slots.unshift(undefined as unknown as RoutineRun["status"]);
  const counted = recent.length
    ? `Last ${recent.length} run${recent.length === 1 ? "" : "s"}, newest last: ${[...recent]
        .reverse()
        .map((s) => WORD[s])
        .join(", ")}.`
    : "No runs yet.";
  return (
    <div className="rk-health">
      <span className="rk-health__strip" aria-hidden="true">
        {slots.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed five slots
          <span key={i} className={`rk-health__dot${s ? ` rk-health__dot--${s}` : ""}`}>
            {s === "failed" ? "!" : ""}
          </span>
        ))}
      </span>
      <span className="sr-only">{counted}</span>
    </div>
  );
}

function Empty({ onAdded, onNew }: { onAdded: (id: string) => void; onNew: () => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: assistant.templates });
  const example = templates.data?.packs.flatMap((p) =>
    p.routines.map((t) => ({ pack: p.id, ...t })),
  )[0];
  const add = useMutation({
    mutationFn: () => assistant.addFromTemplate(example?.pack ?? "", example?.template),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      const id = res.routines.find(
        (r) => r.pack === example?.pack && r.template === example?.template,
      )?.id;
      if (id) onAdded(id);
    },
  });
  return (
    <EmptyState
      headline="Nothing runs while you're away."
      action={
        example ? (
          <Button
            variant="primary"
            loading={add.isPending && "Adding…"}
            onClick={() => add.mutate()}
          >
            Try “{example.name}”
          </Button>
        ) : (
          <Button variant="primary" onClick={onNew}>
            New routine
          </Button>
        )
      }
    >
      A routine summarises your own sources on a schedule, with every sentence cited, and never
      sends anything.
    </EmptyState>
  );
}

function EditDrawer({
  id,
  routines,
  onClose,
  onPick,
}: {
  id: string | null;
  routines: Routine[];
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [citation, setCitation] = useState<Citation | null>(null);
  const routine = routines.find((r) => r.id === id);
  const close = () => {
    setCitation(null);
    onClose();
  };
  return (
    <Drawer open={id !== null} onClose={close} title={routine?.name ?? "New routine"}>
      {id === "new" && <AddRoutine onDone={(added) => (added ? onPick(added) : close())} />}
      {routine && !citation && (
        <RoutineDetail key={routine.id} routine={routine} onOpen={setCitation} onDeleted={close} />
      )}
      {citation && <SourceViewer citation={citation} onClose={() => setCitation(null)} />}
    </Drawer>
  );
}

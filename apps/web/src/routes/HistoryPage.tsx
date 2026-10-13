import type { RunStatusFilter, RunSummary } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Download, Play } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { elapsed } from "../agent-ui/runs.ts";
import { StatusChip } from "../agent-ui/StatusChip.tsx";
import { api, assistant } from "../api.ts";
import {
  Button,
  Card,
  Checkbox,
  type Column,
  EmptyState,
  ErrorState,
  Input,
  Segmented,
  Select,
  Skeleton,
  Table,
  useKeys,
  useToast,
} from "../ui/index.tsx";
import "./screens.css";

const DAY = 86_400_000;
const RANGES = [
  { value: "all", label: "Any time" },
  { value: "1", label: "Last day" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];
const started = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const KIND: Record<RunSummary["kind"], string> = {
  ask: "Question",
  routine: "Routine",
  job: "Job",
  sync: "Sync",
  action: "Action",
};

/**
 * Task history (UI spec 10): every run, folded from the event log on the engine. Search covers
 * titles and receipts; Archive hides a run (with Undo) and never touches the ledger.
 */
export function HistoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search.trim());
  const [status, setStatus] = useState<RunStatusFilter>("all");
  const [range, setRange] = useState("all");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A stable lower bound per choice, so the query key doesn't change every render.
  const [from, setFrom] = useState<number | undefined>(undefined);
  const filters = { q, status, from, archived };
  const list = useQuery({
    queryKey: ["runs", filters],
    queryFn: () => api.runs(filters),
    placeholderData: (prev) => prev,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["runs"] });

  const restore = (ids: string[]) => api.unarchiveRuns(ids).finally(refresh);
  const archive = useMutation({
    mutationFn: (ids: string[]) => api.archiveRuns(ids),
    onSuccess: (_r, ids) => {
      setSelected(new Set());
      refresh();
      toast({
        text: `Archived ${ids.length} run${ids.length === 1 ? "" : "s"}.`,
        action: { label: "Undo", run: () => void restore(ids) },
      });
    },
  });
  const unarchive = useMutation({
    mutationFn: (ids: string[]) => restore(ids),
    onSuccess: () => setSelected(new Set()),
  });
  const rerun = useMutation({
    mutationFn: (r: RunSummary) => assistant.runRoutine(r.routineId as string),
    onSuccess: (_x, r) => {
      toast({ text: `${r.title} is queued again.` });
      refresh();
    },
  });

  const runs = list.data?.runs ?? [];
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  // J/K move between rows, Enter opens the focused one (the row handles Enter itself).
  useKeys((key, e) => {
    if (key !== "j" && key !== "k") return;
    const rows = [...document.querySelectorAll<HTMLElement>("tr[data-run]")];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = key === "j" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
    rows[at < 0 ? 0 : next]?.focus();
    e.preventDefault();
  });

  const exportList = () => {
    const blob = new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rocky-task-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const columns: Column<RunSummary>[] = [
    {
      key: "select",
      title: "Select",
      render: (r) => (
        <Checkbox
          label={<span className="sr-only">Select {r.title}</span>}
          checked={selected.has(r.id)}
          onChange={(on) => toggle(r.id, on)}
        />
      ),
    },
    {
      key: "title",
      title: "Title",
      sort: (r) => r.title.toLowerCase(),
      render: (r) => (
        <Link to="/runs/$id" params={{ id: r.id }} className="rk-history__title" tabIndex={-1}>
          {r.title}
        </Link>
      ),
    },
    {
      key: "status",
      title: "Status",
      sort: (r) => r.state,
      render: (r) => <StatusChip state={r.state} />,
    },
    { key: "kind", title: "Kind", sort: (r) => r.kind, render: (r) => KIND[r.kind] },
    {
      key: "started",
      title: "Started",
      sort: (r) => r.startedAt,
      render: (r) => <span className="rk-nums">{started(r.startedAt)}</span>,
    },
    {
      key: "duration",
      title: "Duration",
      sort: (r) => r.updatedAt - r.startedAt,
      render: (r) => <span className="rk-nums">{elapsed(r.updatedAt - r.startedAt)}</span>,
    },
    {
      key: "outcome",
      title: "Outcome",
      sort: (r) => r.receipts,
      render: (r) => (
        <span className="rk-small">
          {r.receipts > 0 && (
            <span className="rk-muted">
              {r.receipts} receipt{r.receipts === 1 ? "" : "s"} ·{" "}
            </span>
          )}
          {r.outcome ?? <span className="rk-muted">No result recorded</span>}
        </span>
      ),
    },
    {
      key: "actions",
      title: "Actions",
      render: (r) => (
        <span className="rk-history__actions">
          {r.routineId && (
            <Button
              dense
              icon={<Play size={16} strokeWidth={1.5} aria-hidden />}
              loading={rerun.isPending && rerun.variables?.id === r.id && "Queuing…"}
              onClick={() => rerun.mutate(r)}
              aria-label={`Re-run: ${r.title}`}
            >
              Re-run
            </Button>
          )}
          <Button
            dense
            variant="tertiary"
            icon={
              archived ? (
                <ArchiveRestore size={16} strokeWidth={1.5} aria-hidden />
              ) : (
                <Archive size={16} strokeWidth={1.5} aria-hidden />
              )
            }
            onClick={() => (archived ? unarchive.mutate([r.id]) : archive.mutate([r.id]))}
            aria-label={`${archived ? "Restore" : "Archive"}: ${r.title}`}
          >
            {archived ? "Restore" : "Archive"}
          </Button>
        </span>
      ),
    },
  ];

  const filtering = q || status !== "all" || from !== undefined || archived;
  let body: React.ReactNode;
  if (list.isLoading) body = <Skeleton rows={10} height={52} label="Loading task history" />;
  else if (list.error)
    body = (
      <ErrorState
        title="Couldn't read the history."
        happened={list.error.message}
        rockyDid="Nothing was changed."
        fix={
          <Button variant="primary" onClick={refresh}>
            Retry
          </Button>
        }
        details={{ log: "If this keeps happening, run `rocky doctor` in a terminal." }}
      />
    );
  else if (!runs.length && !filtering) body = <Empty />;
  else if (!runs.length) body = <p className="rk-muted">Nothing matches these filters.</p>;
  else
    body = (
      <Table
        caption="Task history"
        columns={columns}
        rows={runs}
        rowKey={(r) => r.id}
        initialSort={{ key: "started", dir: "desc" }}
        rowProps={(r) => ({
          tabIndex: 0,
          "data-run": r.id,
          "aria-selected": selected.has(r.id),
          "aria-label": r.title,
          onKeyDown: (e) => {
            if (e.key === "Enter" && e.target === e.currentTarget)
              void navigate({ to: "/runs/$id", params: { id: r.id } });
          },
        })}
      />
    );

  return (
    <div className="rk-page rk-page--wide">
      <header className="rk-page__head">
        <h1 className="rk-title">History</h1>
        <Link to="/tasks" className="rk-small">
          All tasks
        </Link>
        <span style={{ flex: 1 }} />
        <Button
          disabled={!runs.length}
          icon={<Download size={16} strokeWidth={1.5} aria-hidden />}
          onClick={exportList}
        >
          Export
        </Button>
        <Link to="/ask" className="rk-button rk-button--primary">
          New task
        </Link>
      </header>
      <div className="rk-history__filters">
        <Input
          label="Search titles and receipts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="When"
          value={range}
          onChange={(v) => {
            setRange(v);
            setFrom(v === "all" ? undefined : Date.now() - Number(v) * DAY);
          }}
          options={RANGES}
        />
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Running" },
            { value: "needs_you", label: "Needs you" },
            { value: "done", label: "Done" },
            { value: "failed", label: "Failed" },
          ]}
        />
        <Checkbox
          label="Show archived"
          checked={archived}
          onChange={(on) => {
            setArchived(on);
            setSelected(new Set());
          }}
        />
      </div>
      {selected.size > 0 && (
        <section className="rk-history__bulk" aria-label="Selected runs">
          <span>{selected.size} selected</span>
          <Button
            dense
            onClick={() =>
              archived ? unarchive.mutate([...selected]) : archive.mutate([...selected])
            }
          >
            {archived ? "Restore" : "Archive"} {selected.size}
          </Button>
          <Button dense variant="tertiary" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </section>
      )}
      {(archive.error ?? unarchive.error ?? rerun.error) && (
        <p role="alert" className="rk-small">
          {(archive.error ?? unarchive.error ?? rerun.error)?.message}
        </p>
      )}
      {body}
    </div>
  );
}

function Empty() {
  return (
    <>
      <EmptyState headline="No tasks yet.">
        Questions, routines, syncs and approved actions are listed here once they run.
      </EmptyState>
      <ul className="rk-routines" aria-label="Ways to start">
        <Card as="li" className="rk-routine">
          <h3 className="rk-h3">Summarise a folder</h3>
          <p className="rk-small rk-muted" style={{ margin: 0 }}>
            Add a folder as a project, then ask about it.
          </p>
          <Link to="/projects" className="rk-button rk-button--secondary rk-button--dense">
            Pick a folder
          </Link>
        </Card>
        <Card as="li" className="rk-routine">
          <h3 className="rk-h3">Draft replies</h3>
          <p className="rk-small rk-muted" style={{ margin: 0 }}>
            Rocky drafts; nothing is sent. You approve each draft.
          </p>
          <Link
            to="/ask"
            search={{ q: "Which emails this week still need a reply from me?" }}
            className="rk-button rk-button--secondary rk-button--dense"
          >
            Find mail to answer
          </Link>
        </Card>
        <Card as="li" className="rk-routine">
          <h3 className="rk-h3">A morning brief</h3>
          <p className="rk-small rk-muted" style={{ margin: 0 }}>
            A cited summary of your day, on a schedule.
          </p>
          <Link to="/tasks/background" className="rk-button rk-button--secondary rk-button--dense">
            Set up a routine
          </Link>
        </Card>
      </ul>
    </>
  );
}

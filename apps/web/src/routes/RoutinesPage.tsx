import type { Citation, JobEvent, Routine, RoutineInput } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { assistant, watchJob } from "../api.ts";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { Badge, Button, cls } from "../components/ui.tsx";
import { PathLine, Sentences } from "../components/verified.tsx";
import { DAYS, fromCron, scheduleLabel, toCron } from "../routines.ts";

const INPUTS: { id: RoutineInput; label: string }[] = [
  { id: "calendar_today", label: "Today's calendar" },
  { id: "meetings_today", label: "Today's meetings and lectures" },
  { id: "week_meetings", label: "This week's meetings" },
  { id: "commitments_due_7d", label: "Commitments due in 7 days" },
  { id: "overdue", label: "Overdue commitments" },
  { id: "deadlines_14d", label: "Deadlines in 14 days" },
  { id: "unread_important_threads", label: "Unread important mail" },
];

const inputCls = "min-h-11 rounded-md border border-border-strong bg-page px-3 text-sm";
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** DESIGN screen 9: routines with schedule and on/off; detail with schedule, prompt, last output, Run now. */
export function RoutinesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["routines"], queryFn: assistant.routines });
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Citation | null>(null);
  const toggle = useMutation({
    mutationFn: (r: Routine) => assistant.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routines"] }),
  });
  const routines = list.data?.routines ?? [];
  const current = routines.find((r) => r.id === selected) ?? routines[0];

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="mr-auto text-2xl font-normal leading-8">Routines</h1>
            <Button onClick={() => setAdding((a) => !a)}>
              <Plus size={16} aria-hidden /> Add
            </Button>
          </header>
          <p className="mt-2 text-sm text-secondary">
            Scheduled summaries from your own sources, every sentence cited. Routines only write;
            they never send or change anything. A run missed while this computer slept runs once
            when it wakes.
          </p>
          {adding && (
            <AddRoutine
              onDone={(id) => {
                setAdding(false);
                if (id) setSelected(id);
              }}
            />
          )}
          {list.error && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {list.error.message}
            </p>
          )}
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
            <ul aria-label="Routines" className="flex flex-col gap-1">
              {routines.map((r) => (
                <li key={r.id}>
                  <div
                    className={cls(
                      "flex items-center gap-2 rounded-md px-3 py-2",
                      current?.id === r.id ? "bg-accent-soft" : "hover:bg-layer-faint",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(r.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block text-xs text-secondary">
                        {scheduleLabel(r.schedule)}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={`${r.name} ${r.enabled ? "on" : "off"}`}
                      onClick={() => toggle.mutate(r)}
                      className={cls(
                        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[180ms] ease-ui",
                        r.enabled ? "bg-accent" : "bg-sunken",
                      )}
                    >
                      <span
                        className={cls(
                          "absolute top-0.5 size-5 rounded-full bg-raised shadow-raised-sm transition-transform duration-[240ms] ease-out",
                          r.enabled ? "translate-x-[22px]" : "translate-x-0.5",
                        )}
                      />
                    </button>
                  </div>
                </li>
              ))}
              {list.data && routines.length === 0 && (
                <li className="text-sm text-secondary">
                  No routines yet. Add one from a template.
                </li>
              )}
            </ul>
            {current && <RoutineDetail key={current.id} routine={current} onOpen={setOpen} />}
          </div>
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-30 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

function AddRoutine({ onDone }: { onDone: (id?: string) => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: assistant.templates });
  const add = useMutation({
    mutationFn: ({ pack, template }: { pack: string; template?: string }) =>
      assistant.addFromTemplate(pack, template),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      onDone();
    },
  });
  const custom = useMutation({
    mutationFn: () =>
      assistant.createRoutine({
        name: "My routine",
        schedule: "0 8 * * 1-5",
        inputs: ["calendar_today", "overdue"],
        prompt:
          "Summarize what matters today for {{date}}: events and anything overdue. Under 8 sentences.",
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      onDone(r.id);
    },
  });
  return (
    <section aria-label="Add a routine" className="mt-6 rounded-lg bg-raised p-6 shadow-raised-sm">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {templates.data?.packs.map((p) => (
          <div key={p.id}>
            <h3 className="text-sm font-semibold">{p.name}</h3>
            <p className="text-xs text-secondary">{p.description}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {p.routines.map((t) => (
                <li key={t.template} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {t.name}{" "}
                    <span className="text-xs text-tertiary">{scheduleLabel(t.schedule)}</span>
                  </span>
                  <Button
                    variant="ghost"
                    className="min-h-9 px-2"
                    disabled={add.isPending}
                    onClick={() => add.mutate({ pack: p.id, template: t.template })}
                    aria-label={`Add ${p.name}: ${t.name}`}
                  >
                    <Plus size={14} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={custom.isPending} onClick={() => custom.mutate()}>
          Blank routine
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          Close
        </Button>
      </div>
      {(add.error ?? custom.error) && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {(add.error ?? custom.error)?.message}
        </p>
      )}
    </section>
  );
}

function RoutineDetail({
  routine: r,
  onOpen,
}: {
  routine: Routine;
  onOpen: (c: Citation) => void;
}) {
  const qc = useQueryClient();
  const simple = fromCron(r.schedule);
  const [name, setName] = useState(r.name);
  const [time, setTime] = useState(simple?.time ?? "07:00");
  const [days, setDays] = useState<number[]>(simple?.days ?? [1, 2, 3, 4, 5]);
  const [raw, setRaw] = useState(simple ? "" : r.schedule);
  const [inputs, setInputs] = useState<RoutineInput[]>(r.inputs);
  const [prompt, setPrompt] = useState(r.prompt);
  const [jobId, setJobId] = useState<string | null>(null);
  const [ev, setEv] = useState<JobEvent | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runs = useQuery({ queryKey: ["runs", r.id], queryFn: () => assistant.runs(r.id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["routines"] });
    void qc.invalidateQueries({ queryKey: ["runs", r.id] });
    void qc.invalidateQueries({ queryKey: ["home"] });
  };
  const schedule = raw.trim() || toCron({ time, days });
  const dirty =
    name !== r.name ||
    schedule !== r.schedule ||
    prompt !== r.prompt ||
    inputs.join() !== r.inputs.join();
  const save = useMutation({
    mutationFn: () =>
      assistant.updateRoutine(r.id, {
        name,
        schedule,
        inputs,
        ...(prompt !== r.prompt ? { prompt } : {}),
      }),
    onSuccess: refresh,
  });
  const restore = useMutation({
    mutationFn: () => assistant.updateRoutine(r.id, { prompt: null }),
    onSuccess: (x) => {
      setPrompt(x.prompt);
      refresh();
    },
  });
  const run = useMutation({
    mutationFn: () => assistant.runRoutine(r.id),
    onSuccess: (x) => setJobId(x.jobId),
  });
  const del = useMutation({ mutationFn: () => assistant.deleteRoutine(r.id), onSuccess: refresh });
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow one job at a time
  useEffect(() => {
    if (!jobId) return;
    return watchJob(jobId, (e) => {
      setEv(e);
      if (e.status === "done" || e.status === "failed") {
        setJobId(null);
        refresh();
      }
    });
  }, [jobId]);
  const last = runs.data?.runs[0];

  return (
    <section aria-label={r.name} className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-lg bg-raised p-6 shadow-raised-sm">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
            Name
            <input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </label>
          {r.pack && <Badge>{r.pack}</Badge>}
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Schedule</legend>
          {raw ? (
            <label className="mt-1 flex flex-col gap-1 text-xs text-secondary">
              Cron expression (minute hour day month weekday)
              <input
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                className={cls(inputCls, "font-mono")}
              />
            </label>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`t-${r.id}`}>
                Time
              </label>
              <input
                id={`t-${r.id}`}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cls(inputCls, "w-32")}
              />
              {DAYS.map((d, i) => (
                <label
                  key={d}
                  className={cls(
                    "inline-flex min-h-9 cursor-pointer items-center rounded-full px-3 text-xs",
                    days.includes(i)
                      ? "bg-accent-soft text-primary"
                      : "bg-layer-subtle text-secondary",
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={days.includes(i)}
                    onChange={() =>
                      setDays((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i]))
                    }
                  />
                  {d}
                </label>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-secondary">
            {r.enabled && r.nextRunAt
              ? `Next run ${when(r.nextRunAt)}.`
              : "Off: switch it on in the list to schedule it."}
          </p>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Uses</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {INPUTS.map((i) => (
              <label
                key={i.id}
                className={cls(
                  "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs",
                  inputs.includes(i.id)
                    ? "bg-accent-soft text-primary"
                    : "bg-layer-subtle text-secondary",
                )}
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-[var(--accent-strong)]"
                  checked={inputs.includes(i.id)}
                  onChange={() =>
                    setInputs((x) =>
                      x.includes(i.id) ? x.filter((y) => y !== i.id) : [...x, i.id],
                    )
                  }
                />
                {i.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Instructions
          <textarea
            value={prompt}
            rows={5}
            maxLength={8000}
            onChange={(e) => setPrompt(e.target.value)}
            className="rounded-md border border-border-strong bg-page p-3 text-sm font-normal"
          />
          <span className="text-xs font-normal text-secondary">
            {"{{date}}"} and {"{{time}}"} are filled in at run time.
          </span>
        </label>
        {(save.error ?? restore.error ?? del.error) && (
          <p role="alert" className="text-sm text-danger">
            {(save.error ?? restore.error ?? del.error)?.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!dirty || !inputs.length || !prompt.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
          <Button disabled={run.isPending || jobId !== null} onClick={() => run.mutate()}>
            {jobId ? (
              <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Play size={16} aria-hidden />
            )}
            Run now
          </Button>
          {r.edited && (
            <Button variant="ghost" disabled={restore.isPending} onClick={() => restore.mutate()}>
              <RotateCcw size={16} aria-hidden /> Template text
            </Button>
          )}
          <span className="ml-auto">
            {confirmDelete ? (
              <span className="flex gap-2">
                <Button variant="danger" onClick={() => del.mutate()}>
                  Delete routine
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete routine"
              >
                <Trash2 size={16} aria-hidden />
              </Button>
            )}
          </span>
        </div>
        {jobId && (
          <p aria-live="polite" className="text-xs text-secondary">
            {ev?.status === "running" ? "Running" : "Queued; local models can take a few minutes."}
          </p>
        )}
        {run.error && (
          <p role="alert" className="text-sm text-danger">
            {run.error.message}
          </p>
        )}
      </div>

      <section aria-label="Last output" className="rounded-lg bg-raised p-6 shadow-raised-sm">
        <h2 className="text-sm font-semibold">
          {last ? `Last run, ${when(last.startedAt)}` : "No runs yet"}
        </h2>
        {last?.status === "failed" && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {last.error}
          </p>
        )}
        {last?.status === "done" &&
          (last.notFound ? (
            <p className="mt-2 text-sm text-secondary">Nothing to report from your sources.</p>
          ) : (
            <div className="mt-2 space-y-2">
              <Sentences answer={last.answer} onOpen={onOpen} />
              <PathLine path={last.path} />
            </div>
          ))}
        {(runs.data?.runs.length ?? 0) > 1 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-secondary">Earlier runs</summary>
            <ul className="mt-2 flex flex-col gap-3">
              {runs.data?.runs.slice(1).map((x) => (
                <li key={x.id}>
                  <p className="text-xs text-secondary">
                    {when(x.startedAt)} ·{" "}
                    {x.status === "failed"
                      ? `failed: ${x.error}`
                      : x.notFound
                        ? "nothing to report"
                        : `${x.answer.length} sentences`}
                  </p>
                  {x.status === "done" && !x.notFound && (
                    <Sentences
                      answer={x.answer}
                      onOpen={onOpen}
                      className="text-sm leading-6 text-primary"
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </section>
  );
}

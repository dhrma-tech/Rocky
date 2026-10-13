import type { Citation, JobEvent, Routine, RoutineInput } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { assistant, watchJob } from "../api.ts";
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

/**
 * The routine editor and the template picker, opened from Background (UI spec 11) in a drawer.
 */
export function AddRoutine({ onDone }: { onDone: (id?: string) => void }) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: assistant.templates });
  const add = useMutation({
    mutationFn: ({ pack, template }: { pack: string; template?: string }) =>
      assistant.addFromTemplate(pack, template),
    onSuccess: (res, v) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      onDone(res.routines.find((r) => r.pack === v.pack && r.template === v.template)?.id);
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
    <section aria-label="Add a routine" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4">
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
      </div>
      {(add.error ?? custom.error) && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {(add.error ?? custom.error)?.message}
        </p>
      )}
    </section>
  );
}

export function RoutineDetail({
  routine: r,
  onOpen,
  onDeleted,
}: {
  routine: Routine;
  onOpen: (c: Citation) => void;
  onDeleted: () => void;
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
  const del = useMutation({
    mutationFn: () => assistant.deleteRoutine(r.id),
    onSuccess: () => {
      refresh();
      onDeleted();
    },
  });
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
      <div className="flex flex-col gap-4">
        {r.file && (
          <p className="text-sm text-secondary">
            This routine lives in <code className="break-all font-mono">{r.file}</code>. Edit that
            file to change it; here you can run it or pause it.
          </p>
        )}
        <fieldset disabled={r.file !== null} className="flex min-w-0 flex-col gap-4">
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
                : "Paused: resume it on its card to schedule it."}
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
        </fieldset>
        {(save.error ?? restore.error ?? del.error) && (
          <p role="alert" className="text-sm text-danger">
            {(save.error ?? restore.error ?? del.error)?.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!r.file && (
            <Button
              variant="primary"
              disabled={!dirty || !inputs.length || !prompt.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          )}
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

      <section aria-label="Last output">
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

import type { RoutineInput } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, assistant, projects } from "./api.ts";
import { DAYS, INPUTS, scheduleLabel, toCron } from "./routines.ts";
import {
  Button,
  Card,
  Checkbox,
  Drawer,
  Input,
  Segmented,
  Select,
  Textarea,
  useToast,
} from "./ui/index.tsx";

/**
 * Task creation (UI spec 6), sized to what the engine runs today (D-017, D-061): a one-off task
 * is a cited question, optionally scoped to a project; a repeating one is a routine. The preview
 * card says in plain words what Rocky will and won't be allowed to do. Closing keeps the draft.
 */

type When = "once" | "daily" | "weekdays" | "weekly";
interface Draft {
  goal: string;
  when: When;
  time: string;
  day: number;
  project: string;
  inputs: RoutineInput[];
}
const EMPTY: Draft = {
  goal: "",
  when: "once",
  time: "08:00",
  day: 1,
  project: "",
  inputs: ["calendar_today", "overdue"],
};
const KEY = "rocky.task-draft";
const loadDraft = (): Draft => {
  try {
    return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Draft>) };
  } catch {
    return EMPTY;
  }
};
const keepDraft = (d: Draft) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Storage can be off (private window); the draft then lasts until the page reloads.
  }
};

const TEMPLATES: { title: string; about: string; draft: Partial<Draft> }[] = [
  {
    title: "Summarise a folder",
    about: "Pick a project, then ask for the gist with sources.",
    draft: { goal: "Summarise what is in this folder and what is still open.", when: "once" },
  },
  {
    title: "A morning brief",
    about: "Today's calendar and anything overdue, on weekdays.",
    draft: {
      goal: "Summarise what matters today: events and anything overdue. Under 8 sentences.",
      when: "weekdays",
      time: "08:00",
      inputs: ["calendar_today", "overdue"],
    },
  },
  {
    title: "Find mail to answer",
    about: "Which threads still need a reply from you. Drafts wait for approval.",
    draft: { goal: "Which emails this week still need a reply from me?", when: "once" },
  },
];

/** Opens the drawer from anywhere (Tasks, History, the palette). */
export const openTaskCreator = () => window.dispatchEvent(new Event("rocky:new-task"));

export function TaskCreator() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("rocky:new-task", onOpen);
    return () => window.removeEventListener("rocky:new-task", onOpen);
  }, []);
  useEffect(() => keepDraft(draft), [draft]);
  return (
    <Drawer open={open} onClose={() => setOpen(false)} title="New task">
      {open && (
        <TaskForm
          draft={draft}
          setDraft={setDraft}
          onDone={() => {
            setDraft(EMPTY);
            setOpen(false);
          }}
        />
      )}
    </Drawer>
  );
}

function TaskForm({
  draft,
  setDraft,
  onDone,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const projectList = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const once = draft.when === "once";
  const live = (projectList.data?.projects ?? []).filter((p) => p.archivedAt === null);
  const project = live.find((p) => p.id === draft.project);
  const schedule = toCron({
    time: draft.time,
    days:
      draft.when === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : draft.when === "weekdays"
          ? [1, 2, 3, 4, 5]
          : [draft.day],
  });

  const save = useMutation({
    mutationFn: () =>
      assistant.createRoutine({
        name: draft.goal.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 100),
        schedule,
        inputs: draft.inputs,
        prompt: draft.goal.trim(),
        enabled: true,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      toast({ text: `Saved. ${r.name} runs ${scheduleLabel(r.schedule).toLowerCase()}.` });
      onDone();
      void navigate({ to: "/tasks/background" });
    },
  });

  const submit = () => {
    if (!draft.goal.trim()) return setError("Say what you want Rocky to do.");
    if (!once && !draft.inputs.length) return setError("Pick at least one thing to read.");
    setError(null);
    if (once) {
      onDone();
      void navigate({
        to: "/ask",
        search: { q: draft.goal.trim(), ...(project ? { project: project.id } : {}) },
      });
    } else save.mutate();
  };

  const reads = once
    ? project
      ? `the files in ${project.name} (${project.folder})`
      : "everything you've added to Rocky"
    : INPUTS.filter((i) => draft.inputs.includes(i.id))
        .map((i) => i.label.toLowerCase())
        .join(", ") || "nothing yet";

  return (
    <form
      className="rk-taskform"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!draft.goal && (
        <ul className="rk-taskform__templates" aria-label="Start from an example">
          {TEMPLATES.map((t) => (
            <Card as="li" key={t.title} className="rk-routine">
              <button
                type="button"
                className="rk-taskform__template"
                onClick={() => setDraft({ ...draft, ...t.draft })}
              >
                <strong>{t.title}</strong>
                <span className="rk-small rk-muted">{t.about}</span>
              </button>
            </Card>
          ))}
        </ul>
      )}
      <Textarea
        label="What should Rocky do?"
        value={draft.goal}
        rows={3}
        maxLength={4000}
        error={error}
        onChange={(e) => set({ goal: e.target.value })}
      />
      <Segmented
        label="When"
        value={draft.when}
        onChange={(when) => set({ when })}
        options={[
          { value: "once", label: "Now, once" },
          { value: "daily", label: "Daily" },
          { value: "weekdays", label: "Weekdays" },
          { value: "weekly", label: "Weekly" },
        ]}
      />
      {!once && (
        <div className="rk-taskform__row">
          <Input
            label="At"
            type="time"
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
          />
          {draft.when === "weekly" && (
            <Select
              label="On"
              value={String(draft.day)}
              onChange={(v) => set({ day: Number(v) })}
              options={DAYS.map((d, i) => ({ value: String(i), label: d }))}
            />
          )}
        </div>
      )}
      {once ? (
        <Select
          label="Look in"
          help="A project keeps the answer to that folder's files."
          value={draft.project}
          onChange={(v) => set({ project: v })}
          options={[
            { value: "", label: "Everything in Rocky" },
            ...live.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : (
        <fieldset className="rk-taskform__inputs">
          <legend className="rk-field__label">What it reads</legend>
          {INPUTS.map((i) => (
            <Checkbox
              key={i.id}
              label={i.label}
              checked={draft.inputs.includes(i.id)}
              onChange={(on) =>
                set({
                  inputs: on ? [...draft.inputs, i.id] : draft.inputs.filter((x) => x !== i.id),
                })
              }
            />
          ))}
        </fieldset>
      )}

      <section className="rk-taskform__preview" aria-labelledby="task-preview">
        <h3 id="task-preview" className="rk-h3" style={{ margin: 0 }}>
          What Rocky will be allowed to do
        </h3>
        <ul>
          <li>
            <strong>Read</strong> {reads}.
          </li>
          <li>
            <strong>Answer</strong> with a source for every sentence, or say it found nothing.
          </li>
          <li>
            <strong>Change nothing</strong> in your files or apps. Anything it suggests waits in
            Approvals, under your rules. It never sends email.
          </li>
          <li>
            <strong>Models:</strong>{" "}
            {settings.data?.localOnly
              ? "only on this computer (local-only is on)."
              : `on this computer first; cloud use stops at your $${settings.data?.budget.monthlyCapUsd ?? "—"} monthly cap.`}
          </li>
          {!once && (
            <li>
              <strong>When:</strong> {scheduleLabel(schedule)}. A run missed while the computer
              slept happens once when it wakes.
            </li>
          )}
        </ul>
      </section>
      {save.error && (
        <p role="alert" className="rk-small">
          Couldn't save: {save.error.message}. Your draft is still here.
        </p>
      )}
      <div className="rk-taskform__footer">
        <Button variant="tertiary" onClick={() => setDraft(EMPTY)} disabled={!draft.goal}>
          Clear
        </Button>
        <Button variant="primary" type="submit" loading={save.isPending && "Saving…"}>
          {once ? "Start task" : "Save routine"}
        </Button>
      </div>
    </form>
  );
}

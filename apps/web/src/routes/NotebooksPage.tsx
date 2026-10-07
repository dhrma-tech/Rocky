import type { NotebookKind } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, CalendarClock, Layers, Plus, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../api.ts";
import { ProgressRing } from "../components/study.tsx";
import { Button, linkButton, Toggle } from "../components/ui.tsx";
import { daysLabel, daysUntil, parseList } from "../study.ts";

const inputCls = "min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm";

/** DESIGN screen 3 (list): notebook cards with source count, next exam and a progress ring. */
export function NotebooksPage() {
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ["notebooks"], queryFn: api.notebooks });

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-normal leading-8">Notebooks</h1>
        <Link to="/study" className={linkButton}>
          <Layers size={16} aria-hidden /> Study
        </Link>
      </header>
      <p className="mt-2 text-sm text-secondary">
        A notebook is a saved scope over your memory: a course folder, a Notion page, recorded
        lectures. Ask, quiz and review inside it, with every answer cited.
      </p>

      {list.error && (
        <p role="alert" className="mt-6 text-sm text-danger">
          {list.error.message}
        </p>
      )}
      <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.isLoading &&
          [0, 1, 2].map((i) => (
            <li
              key={i}
              aria-hidden
              className="h-40 animate-pulse rounded-lg bg-layer-subtle motion-reduce:animate-none"
            />
          ))}
        {list.data?.notebooks.map((n) => {
          const d = n.nextExam ? daysUntil(n.nextExam.at) : null;
          return (
            <li key={n.id}>
              <Link
                to="/notebooks/$id"
                params={{ id: n.id }}
                className="flex h-full flex-col gap-3 rounded-lg bg-raised p-5 text-primary no-underline shadow-raised-sm transition-[transform,box-shadow] duration-[180ms] ease-ui hover:-translate-y-px hover:shadow-raised-md"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-display text-lg leading-7">{n.name}</h2>
                    <p className="truncate text-xs text-secondary">
                      {[n.term, n.instructor].filter(Boolean).join(" · ") || kindLabel(n.kind)}
                    </p>
                  </div>
                  <ProgressRing value={n.mastery} />
                </div>
                <p className="tabular text-xs text-secondary">
                  {n.sourceCount} source{n.sourceCount === 1 ? "" : "s"} · {n.cardCount} card
                  {n.cardCount === 1 ? "" : "s"}
                  {n.dueCount > 0 && ` · ${n.dueCount} due`}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-2 text-xs">
                  {n.nextExam && d !== null && (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <CalendarClock size={14} aria-hidden className="text-accent-strong" />
                      {n.nextExam.title} {daysLabel(d)}
                    </span>
                  )}
                  {n.localOnly && (
                    <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5">
                      <ShieldCheck size={12} aria-hidden /> Local only
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
        {list.data && (
          <li>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong text-sm text-secondary transition-colors duration-[180ms] ease-ui hover:bg-layer-subtle"
            >
              <Plus size={20} aria-hidden className="text-accent-strong" />
              New notebook
            </button>
          </li>
        )}
      </ul>
      {list.data?.notebooks.length === 0 && (
        <p className="mt-4 flex items-center gap-2 text-sm text-secondary">
          <BookOpen size={16} aria-hidden /> No notebooks yet. Create one for each course.
        </p>
      )}
      {creating && <CreateNotebook onClose={() => setCreating(false)} />}
    </div>
  );
}

const kindLabel = (k: NotebookKind) =>
  k === "course" ? "Course" : k === "project" ? "Project" : "Research";

/** Modal: name, kind, term, course code (becomes a title rule), local-only. Details live on the notebook. */
function CreateNotebook({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NotebookKind>("course");
  const [term, setTerm] = useState("");
  const [codes, setCodes] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const titleMatches = parseList(codes);
  const preview = useQuery({
    queryKey: ["scope-preview", titleMatches],
    queryFn: () => api.previewScope({ titleMatches }),
    enabled: titleMatches.length > 0,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createNotebook({
        name: name.trim(),
        kind,
        term: term.trim() || null,
        localOnly,
        scope: {
          documentIds: [],
          excludedIds: [],
          rules: titleMatches.length ? { titleMatches } : {},
        },
      }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ["notebooks"] });
      void navigate({ to: "/notebooks/$id", params: { id: n.id } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4">
      <form
        role="dialog"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        aria-modal="true"
        aria-labelledby="new-notebook-title"
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-4 rounded-lg bg-overlay p-6 shadow-raised-lg"
      >
        <h2 id="new-notebook-title" className="text-lg font-semibold">
          New notebook
        </h2>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CS201 Data Structures"
            className={inputCls}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as NotebookKind)}
              className={inputCls}
            >
              <option value="course">Course</option>
              <option value="project">Project</option>
              <option value="research">Research</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Term
            <input
              maxLength={100}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Fall 2026"
              className={inputCls}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Course codes or title words
          <input
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder="CS201, Data Structures"
            className={inputCls}
          />
          <span className="text-xs font-normal text-secondary">
            {titleMatches.length === 0
              ? "Optional. Documents whose title contains any of these join the notebook. Add Drive folders and Notion pages after."
              : preview.data
                ? `${preview.data.count} document${preview.data.count === 1 ? "" : "s"} match right now.`
                : "Counting matches…"}
          </span>
        </label>
        <Toggle
          label="Local only"
          description="Questions and study in this notebook never call an API model."
          checked={localOnly}
          onChange={setLocalOnly}
        />
        {create.error && (
          <p role="alert" className="text-sm text-danger">
            {create.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
            Create notebook
          </Button>
        </div>
      </form>
    </div>
  );
}

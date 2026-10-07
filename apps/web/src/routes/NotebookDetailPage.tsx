import type {
  Citation,
  ExamDate,
  Notebook,
  ScheduleSlot,
  ScopeRules,
  SourceType,
} from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Calendar,
  FileText,
  GitBranch,
  Mail,
  Mic,
  NotebookText,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { SourceViewer } from "../components/SourceViewer.tsx";
import { ProgressRing } from "../components/study.tsx";
import { Badge, Button, cls, IconButton, Toggle } from "../components/ui.tsx";
import {
  cleanRules,
  daysLabel,
  daysUntil,
  parseIds,
  parseList,
  rulesSummary,
  slotLabel,
} from "../study.ts";
import { AskView } from "./AskPage.tsx";
import { ExportsTab, MindMapTab, StudyTab } from "./NotebookStudy.tsx";

const TABS = ["Chat", "Sources", "Study", "Mind map", "Exports"] as const;
type Tab = (typeof TABS)[number];

export const inputCls =
  "min-h-11 w-full rounded-md border border-border-strong bg-page px-3 text-sm";

/** DESIGN screen 3 (detail): header with scope and the per-notebook Local only toggle, then tabs. */
export function NotebookDetailPage() {
  const { id } = useParams({ from: "/notebooks/$id" });
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("Chat");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<Citation | null>(null);
  const nb = useQuery({ queryKey: ["notebook", id], queryFn: () => api.notebook(id) });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateNotebook>[1]) => api.updateNotebook(id, patch),
    onSuccess: (n) => {
      qc.setQueryData(["notebook", id], n);
      void qc.invalidateQueries({ queryKey: ["notebooks"] });
      void qc.invalidateQueries({ queryKey: ["sources", id] });
    },
  });

  if (nb.error)
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-8">
        <p role="alert" className="text-sm text-danger">
          {nb.error.message}
        </p>
        <Link to="/notebooks">Back to notebooks</Link>
      </div>
    );
  if (!nb.data)
    return <div aria-hidden className="m-16 h-32 animate-pulse rounded-lg bg-layer-subtle" />;
  const n = nb.data;
  const rules = rulesSummary(n.scope.rules);
  const days = n.nextExam ? daysUntil(n.nextExam.at) : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print border-b border-border-base px-4 pb-0 pt-14 sm:px-8">
          <div className="flex flex-wrap items-start gap-3">
            <Link
              to="/notebooks"
              aria-label="All notebooks"
              title="All notebooks"
              className="-ml-3 inline-flex size-11 items-center justify-center rounded-md text-primary hover:bg-layer-subtle"
            >
              <ArrowLeft size={20} aria-hidden />
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-2xl leading-8">{n.name}</h1>
              <p className="text-xs text-secondary">
                {[n.term, n.instructor].filter(Boolean).join(" · ")}
                {(n.term || n.instructor) && " · "}
                {n.sourceCount} source{n.sourceCount === 1 ? "" : "s"}
                {rules.length > 0 && ` · ${rules.join(" · ")}`}
                {n.scope.documentIds.length > 0 && ` · ${n.scope.documentIds.length} added by hand`}
              </p>
              {n.nextExam && days !== null && (
                <p className="mt-1 text-xs text-primary">
                  {n.nextExam.title} {daysLabel(days)}
                </p>
              )}
            </div>
            <ProgressRing value={n.mastery} />
            <div className="w-52">
              <Toggle
                label="Local only"
                description="This notebook never calls an API model."
                checked={n.localOnly}
                disabled={save.isPending}
                onChange={(localOnly) => save.mutate({ localOnly })}
              />
            </div>
            <IconButton label="Course details" onClick={() => setEditing((e) => !e)}>
              <Settings2 size={20} aria-hidden />
            </IconButton>
          </div>
          {save.error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {save.error.message}
            </p>
          )}
          {editing && <DetailsPanel notebook={n} onClose={() => setEditing(false)} />}
          <div role="tablist" aria-label="Notebook" className="mt-4 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls="notebook-panel"
                onClick={() => setTab(t)}
                className={cls(
                  "relative min-h-11 shrink-0 rounded-t-md px-4 text-sm transition-colors duration-[180ms] ease-ui hover:bg-layer-subtle",
                  tab === t &&
                    "font-semibold after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full after:bg-accent-strong",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </header>
        <div
          id="notebook-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {tab === "Chat" ? (
            <AskView
              key={n.id}
              notebookIds={[n.id]}
              heading={`Ask ${n.name}`}
              grounding="Answers are grounded in this notebook's sources. “Not in your sources” is a valid answer."
            />
          ) : (
            <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
              {tab === "Sources" && <SourcesTab notebook={n} />}
              {tab === "Study" && <StudyTab notebook={n} onOpen={setOpen} />}
              {tab === "Mind map" && <MindMapTab notebook={n} onOpen={setOpen} />}
              {tab === "Exports" && <ExportsTab notebook={n} onOpen={setOpen} />}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="no-print fixed inset-0 z-30 lg:relative lg:z-20">
          <SourceViewer citation={open} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

// --- Sources tab ---

const TYPE_ICON: Partial<Record<string, typeof FileText>> = {
  transcript: Mic,
  meeting: Mic,
  email: Mail,
  notion: NotebookText,
  github: GitBranch,
  calendar: Calendar,
};

const SOURCE_TYPES: SourceType[] = [
  "pdf",
  "docx",
  "markdown",
  "text",
  "html",
  "transcript",
  "meeting",
  "email",
  "notion",
  "github",
  "calendar",
  "task",
  "chat",
  "analytics",
];

const day = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
const toDateInput = (ms: number | undefined) =>
  ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : "";
const fromDateInput = (s: string, endOfDay = false) =>
  s ? new Date(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}`).getTime() : undefined;

function SourcesTab({ notebook: n }: { notebook: Notebook }) {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ["sources", n.id],
    queryFn: () => api.notebookSources(n.id),
  });
  const refresh = (nb: Notebook) => {
    qc.setQueryData(["notebook", n.id], nb);
    void qc.invalidateQueries({ queryKey: ["sources", n.id] });
    void qc.invalidateQueries({ queryKey: ["notebooks"] });
  };
  const remove = useMutation({
    mutationFn: (docId: string) => api.removeSource(n.id, docId),
    onSuccess: refresh,
  });

  return (
    <div className="flex flex-col gap-8">
      <RulesEditor notebook={n} onSaved={refresh} />
      <AddDocument notebook={n} onAdded={refresh} />
      <section aria-labelledby="sources-h">
        <h2 id="sources-h" className="text-lg font-semibold">
          Sources
        </h2>
        <p className="text-sm text-secondary">
          Removing a source that a rule added keeps it out of this notebook; the document stays in
          your memory.
        </p>
        {sources.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {sources.error.message}
          </p>
        )}
        {remove.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {remove.error.message}
          </p>
        )}
        {sources.data?.sources.length === 0 && (
          <p className="mt-4 rounded-lg bg-raised p-6 text-center text-sm text-secondary shadow-raised-sm">
            No sources yet. Add a rule or a document above.
          </p>
        )}
        <ul className="mt-4 flex flex-col gap-1">
          {sources.data?.sources.map((s) => {
            const Icon = TYPE_ICON[s.sourceType] ?? FileText;
            return (
              <li
                key={s.documentId}
                className="flex min-h-12 items-center gap-3 rounded-md px-3 hover:bg-layer-faint"
              >
                <Icon size={16} aria-hidden className="shrink-0 text-accent-strong" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{s.title}</span>
                  <span className="block text-xs text-secondary">
                    {s.sourceType}
                    {s.connectorId && ` · ${s.connectorId}`}
                    {s.updatedAt && ` · synced ${day(s.updatedAt)}`}
                  </span>
                </span>
                <Badge tone={s.addedBy === "manual" ? "accent" : "neutral"}>
                  {s.addedBy === "manual" ? "Added" : "Rule"}
                </Badge>
                <IconButton
                  label={`Remove ${s.title} from this notebook`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(s.documentId)}
                >
                  <X size={16} aria-hidden />
                </IconButton>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** Scope builder: rules are OR'ed (titles, Drive folders, Notion pages); types and dates narrow. */
function RulesEditor({
  notebook: n,
  onSaved,
}: {
  notebook: Notebook;
  onSaved: (n: Notebook) => void;
}) {
  const r = n.scope.rules;
  const [titles, setTitles] = useState((r.titleMatches ?? []).join(", "));
  const [drive, setDrive] = useState((r.driveFolderIds ?? []).join("\n"));
  const [notion, setNotion] = useState((r.notionPageIds ?? []).join("\n"));
  const [types, setTypes] = useState<SourceType[]>(r.sourceTypes ?? []);
  const [from, setFrom] = useState(toDateInput(r.dateFrom));
  const [to, setTo] = useState(toDateInput(r.dateTo));
  const draft: ScopeRules = cleanRules({
    ...(r.connectorIds ? { connectorIds: r.connectorIds } : {}),
    titleMatches: parseList(titles),
    driveFolderIds: parseIds(drive, "drive"),
    notionPageIds: parseIds(notion, "notion"),
    sourceTypes: types,
    ...(fromDateInput(from) !== undefined ? { dateFrom: fromDateInput(from) } : {}),
    ...(fromDateInput(to, true) !== undefined ? { dateTo: fromDateInput(to, true) } : {}),
  });
  const changed = JSON.stringify(draft) !== JSON.stringify(cleanRules(r));
  const preview = useQuery({
    queryKey: ["scope-preview", draft],
    queryFn: () => api.previewScope(draft),
    enabled: changed && Object.keys(draft).length > 0,
  });
  const save = useMutation({
    mutationFn: () => api.updateNotebook(n.id, { scope: { ...n.scope, rules: draft } }),
    onSuccess: onSaved,
  });

  return (
    <section aria-labelledby="rules-h" className="rounded-lg bg-raised p-6 shadow-raised-sm">
      <h2 id="rules-h" className="text-lg font-semibold">
        Scope rules
      </h2>
      <p className="text-sm text-secondary">
        New documents that match join automatically. Rules re-run on every sync.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium md:col-span-2">
          Title contains
          <input
            value={titles}
            onChange={(e) => setTitles(e.target.value)}
            placeholder="CS201, Data Structures"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Drive folders (links or ids, with subfolders)
          <textarea
            rows={2}
            value={drive}
            onChange={(e) => setDrive(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/…"
            className={cls(inputCls, "py-2")}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Notion pages (links or ids, with sub-pages)
          <textarea
            rows={2}
            value={notion}
            onChange={(e) => setNotion(e.target.value)}
            placeholder="https://www.notion.so/…"
            className={cls(inputCls, "py-2")}
          />
        </label>
        <fieldset className="md:col-span-2">
          <legend className="text-sm font-medium">Only these types (none = all)</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {SOURCE_TYPES.map((t) => (
              <label
                key={t}
                className={cls(
                  "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs",
                  types.includes(t)
                    ? "bg-accent-soft text-primary"
                    : "bg-layer-subtle text-secondary",
                )}
              >
                <input
                  type="checkbox"
                  checked={types.includes(t)}
                  onChange={() =>
                    setTypes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))
                  }
                  className="size-3.5 accent-[var(--accent-strong)]"
                />
                {t}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Until
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!changed || save.isPending}
          onClick={() => save.mutate()}
        >
          Save rules
        </Button>
        <span aria-live="polite" className="text-sm text-secondary">
          {changed && Object.keys(draft).length === 0 && "No rules: only hand-added documents."}
          {changed &&
            preview.data &&
            `${preview.data.count} document${preview.data.count === 1 ? "" : "s"} match${preview.data.count === 1 ? "es" : ""}.`}
          {preview.error?.message}
        </span>
        {save.error && (
          <p role="alert" className="w-full text-sm text-danger">
            {save.error.message}
          </p>
        )}
      </div>
      {changed && preview.data && preview.data.sample.length > 0 && (
        <ul
          aria-label="Matching documents (sample)"
          className="mt-3 flex flex-col gap-1 text-xs text-secondary"
        >
          {preview.data.sample.map((d) => (
            <li key={d.id} className="truncate">
              {d.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Manual add: search document titles in memory and add one. */
function AddDocument({
  notebook: n,
  onAdded,
}: {
  notebook: Notebook;
  onAdded: (n: Notebook) => void;
}) {
  const [q, setQ] = useState("");
  const term = q.trim();
  const found = useQuery({
    queryKey: ["doc-search", term],
    queryFn: () => api.previewScope({ titleMatches: [term] }),
    enabled: term.length >= 2,
  });
  const add = useMutation({
    mutationFn: (docId: string) => api.addSource(n.id, docId),
    onSuccess: onAdded,
  });
  const inScope = new Set(n.scope.documentIds);
  return (
    <section aria-labelledby="add-h">
      <h2 id="add-h" className="text-lg font-semibold">
        Add a document
      </h2>
      <label className="relative mt-2 block">
        <span className="sr-only">Search your documents by title</span>
        <Search size={16} aria-hidden className="absolute left-3 top-3.5 text-tertiary" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your documents by title"
          className={cls(inputCls, "pl-9")}
        />
      </label>
      {found.data && (
        <ul className="mt-2 flex flex-col gap-1">
          {found.data.sample.length === 0 && (
            <li className="text-sm text-secondary">No matches.</li>
          )}
          {found.data.sample.map((d) => (
            <li
              key={d.id}
              className="flex min-h-11 items-center gap-2 rounded-md px-3 hover:bg-layer-faint"
            >
              <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
              {inScope.has(d.id) ? (
                <span className="text-xs text-secondary">Added</span>
              ) : (
                <Button
                  variant="ghost"
                  disabled={add.isPending}
                  onClick={() => add.mutate(d.id)}
                  aria-label={`Add ${d.title}`}
                >
                  <Plus size={16} aria-hidden /> Add
                </Button>
              )}
            </li>
          ))}
          {found.data.count > found.data.sample.length && (
            <li className="px-3 text-xs text-tertiary">
              {found.data.count - found.data.sample.length} more; type more of the title.
            </li>
          )}
        </ul>
      )}
      {add.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {add.error.message}
        </p>
      )}
    </section>
  );
}

// --- Course details ---

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Course setup (notebooks.md): name, term, instructor, weekly slots, exam dates, capture default. */
function DetailsPanel({ notebook: n, onClose }: { notebook: Notebook; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(n.name);
  const [term, setTerm] = useState(n.term ?? "");
  const [instructor, setInstructor] = useState(n.instructor ?? "");
  const [schedule, setSchedule] = useState<ScheduleSlot[]>(n.schedule);
  const [exams, setExams] = useState<ExamDate[]>(n.examDates);
  const [examTag, setExamTag] = useState(n.examTag);
  const [captureDefault, setCaptureDefault] = useState(n.captureDefault);
  const [slot, setSlot] = useState<ScheduleSlot>({ day: 1, start: "09:00", end: "10:30" });
  const [exam, setExam] = useState({ title: "", date: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.updateNotebook(n.id, {
        name: name.trim(),
        term: term.trim() || null,
        instructor: instructor.trim() || null,
        schedule,
        examDates: exams,
        examTag: examTag.trim() || "exam",
        captureDefault,
      }),
    onSuccess: (nb) => {
      qc.setQueryData(["notebook", n.id], nb);
      void qc.invalidateQueries({ queryKey: ["notebooks"] });
      void qc.invalidateQueries({ queryKey: ["countdown", n.id] });
      onClose();
    },
  });
  const del = useMutation({
    mutationFn: (withSources: boolean) => api.deleteNotebook(n.id, withSources),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notebooks"] });
      void navigate({ to: "/notebooks" });
    },
  });

  return (
    <section
      aria-label="Course details"
      className="mt-4 flex flex-col gap-4 rounded-lg bg-raised p-6 shadow-raised-sm"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name
          <input
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Term
          <input
            value={term}
            maxLength={100}
            onChange={(e) => setTerm(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Instructor
          <input
            value={instructor}
            maxLength={200}
            onChange={(e) => setInstructor(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-semibold">Class schedule</legend>
        <ul className="mt-1 flex flex-wrap gap-2">
          {schedule.map((s, i) => (
            <li
              key={`${s.day}-${s.start}`}
              className="inline-flex items-center gap-1 rounded-full bg-layer-subtle pl-3 text-xs"
            >
              {slotLabel(s)}
              <IconButton
                label={`Remove ${slotLabel(s)}`}
                onClick={() => setSchedule((x) => x.filter((_, j) => j !== i))}
                className="size-8"
              >
                <X size={12} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            Day
            <select
              value={slot.day}
              onChange={(e) => setSlot({ ...slot, day: Number(e.target.value) })}
              className={cls(inputCls, "w-36")}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Start
            <input
              type="time"
              value={slot.start}
              onChange={(e) => setSlot({ ...slot, start: e.target.value })}
              className={cls(inputCls, "w-32")}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            End
            <input
              type="time"
              value={slot.end}
              onChange={(e) => setSlot({ ...slot, end: e.target.value })}
              className={cls(inputCls, "w-32")}
            />
          </label>
          <Button
            disabled={!slot.start || !slot.end || slot.end <= slot.start}
            onClick={() => setSchedule((x) => [...x, slot])}
          >
            <Plus size={16} aria-hidden /> Add slot
          </Button>
        </div>
        <div className="mt-3">
          <Toggle
            label="Record lectures into this notebook during its slots"
            checked={captureDefault}
            onChange={setCaptureDefault}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Exam dates</legend>
        <ul className="mt-1 flex flex-col gap-1">
          {exams.map((e, i) => (
            <li key={`${e.title}-${e.at}`} className="flex min-h-10 items-center gap-2 text-sm">
              <span className="flex-1">
                {e.title} · {day(e.at)}
              </span>
              <IconButton
                label={`Remove ${e.title}`}
                onClick={() => setExams((x) => x.filter((_, j) => j !== i))}
              >
                <X size={16} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            Title
            <input
              value={exam.title}
              maxLength={200}
              onChange={(e) => setExam({ ...exam, title: e.target.value })}
              placeholder="Midterm"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Date
            <input
              type="date"
              value={exam.date}
              onChange={(e) => setExam({ ...exam, date: e.target.value })}
              className={cls(inputCls, "w-44")}
            />
          </label>
          <Button
            disabled={!exam.title.trim() || !exam.date}
            onClick={() => {
              const at = fromDateInput(exam.date);
              if (at === undefined) return;
              setExams((x) => [...x, { title: exam.title.trim(), at }].sort((a, b) => a.at - b.at));
              setExam({ title: "", date: "" });
            }}
          >
            <Plus size={16} aria-hidden /> Add exam
          </Button>
        </div>
        <label className="mt-3 flex max-w-xs flex-col gap-1 text-sm font-medium">
          Calendar tag for exams
          <input
            value={examTag}
            maxLength={50}
            onChange={(e) => setExamTag(e.target.value)}
            className={inputCls}
          />
          <span className="text-xs font-normal text-secondary">
            Calendar events in this notebook whose title contains it count as exams.
          </span>
        </label>
      </fieldset>

      {save.error && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save details
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {confirmDelete ? (
            <>
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(false)}>
                Delete notebook, keep documents
              </Button>
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(true)}>
                Delete with its sources
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete notebook
            </Button>
          )}
        </span>
        {del.error && (
          <p role="alert" className="w-full text-sm text-danger">
            {del.error.message}
          </p>
        )}
      </div>
    </section>
  );
}

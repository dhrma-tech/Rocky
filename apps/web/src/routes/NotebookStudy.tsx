import type { Card, Citation, Notebook } from "@rocky/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Layers, Pause, Play, Printer, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { api, assistant } from "../api.ts";
import { ClassBrief } from "../components/ClassBrief.tsx";
import {
  Citations,
  CountdownCard,
  JobButton,
  QuizRunner,
  useStudyJob,
} from "../components/study.tsx";
import { Badge, Button, cls, IconButton, linkButton, Toggle } from "../components/ui.tsx";
import { daysLabel, daysUntil } from "../study.ts";

const MindMapView = lazy(() => import("../components/MindMap.tsx"));

type Open = (c: Citation) => void;

/** Study tab: countdown, flashcards (generate, review, manage), quiz setup, workload. */
export function StudyTab({ notebook: n, onOpen }: { notebook: Notebook; onOpen: Open }) {
  const countdown = useQuery({
    queryKey: ["countdown", n.id],
    queryFn: () => api.countdown(n.id),
  });
  const cardsJob = useStudyJob(n.id, "cards");
  return (
    <div className="flex flex-col gap-8">
      <ClassBrief notebookId={n.id} onOpen={onOpen} />
      {countdown.data && <CountdownCard data={countdown.data} />}
      {countdown.error && (
        <p role="alert" className="text-sm text-danger">
          {countdown.error.message}
        </p>
      )}

      <section aria-labelledby="cards-h" className="flex flex-col gap-3">
        <h2 id="cards-h" className="text-lg font-semibold">
          Flashcards
        </h2>
        <p className="tabular text-sm text-secondary">
          {n.cardCount} card{n.cardCount === 1 ? "" : "s"} · {n.dueCount} due now ·{" "}
          {Math.round(n.mastery * 100)}% mastered. Every card is checked against the passage it came
          from.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          {n.dueCount > 0 && (
            <Link
              to="/study"
              search={{ notebook: n.id }}
              className={cls(linkButton, "bg-accent text-on-accent hover:text-on-accent")}
            >
              <Layers size={16} aria-hidden /> Review {n.dueCount} due
            </Link>
          )}
          <JobButton
            job={cardsJob}
            label={n.cardCount ? "Make more cards" : "Make flashcards"}
            variant={n.dueCount > 0 ? "secondary" : "primary"}
          />
        </div>
        <CardList notebookId={n.id} onOpen={onOpen} />
      </section>

      <QuizSetup
        notebook={n}
        topics={countdown.data?.topics.map((t) => t.topic) ?? []}
        onOpen={onOpen}
      />

      <Workload notebookId={n.id} />
    </div>
  );
}

function CardList({ notebookId, onOpen }: { notebookId: string; onOpen: Open }) {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const cards = useQuery({
    queryKey: ["cards", notebookId],
    queryFn: () => api.cards(notebookId),
    enabled: show,
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["cards", notebookId] });
    void qc.invalidateQueries({ queryKey: ["notebook", notebookId] });
  };
  const patch = useMutation({
    mutationFn: (c: Card) => api.updateCard(c.id, { suspended: !c.suspended }),
    onSuccess: done,
  });
  const del = useMutation({ mutationFn: (id: string) => api.deleteCard(id), onSuccess: done });
  return (
    <details onToggle={(e) => setShow(e.currentTarget.open)} className="text-sm">
      <summary className="cursor-pointer text-secondary">All cards</summary>
      {cards.isLoading && <p className="mt-2 text-secondary">Loading…</p>}
      {(patch.error ?? del.error) && (
        <p role="alert" className="mt-2 text-danger">
          {(patch.error ?? del.error)?.message}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {cards.data?.cards.map((c) => (
          <li
            key={c.id}
            className={cls(
              "flex items-start gap-3 rounded-md px-3 py-2 hover:bg-layer-faint",
              c.suspended && "opacity-60",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{c.front}</span>
              <span className="block text-secondary">
                {c.back} {c.citation && <Citations citations={[c.citation]} onOpen={onOpen} />}
              </span>
              <span className="tabular block text-xs text-tertiary">
                {c.topic ?? "no topic"} · {c.isNew ? "new" : `every ${c.intervalDays} d`}
                {c.dueAt && !c.isNew && ` · due ${daysLabel(daysUntil(c.dueAt))}`}
                {c.suspended && " · suspended"}
              </span>
            </span>
            <IconButton
              label={c.suspended ? "Resume card" : "Suspend card"}
              onClick={() => patch.mutate(c)}
            >
              {c.suspended ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}
            </IconButton>
            <IconButton label="Delete card" onClick={() => del.mutate(c.id)}>
              <Trash2 size={16} aria-hidden />
            </IconButton>
          </li>
        ))}
        {cards.data?.cards.length === 0 && <li className="text-secondary">No cards yet.</li>}
      </ul>
    </details>
  );
}

/** Quiz controls (topics, difficulty, multiple choice, exam-grade), then the answer-first runner. */
function QuizSetup({
  notebook: n,
  topics,
  onOpen,
}: {
  notebook: Notebook;
  topics: string[];
  onOpen: Open;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [multipleChoice, setMultipleChoice] = useState(false);
  const [examGrade, setExamGrade] = useState(false);
  const [quizId, setQuizId] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createQuiz({ notebookId: n.id, topics: picked, difficulty, multipleChoice, examGrade }),
    onSuccess: (q) => setQuizId(q.id),
  });

  return (
    <section aria-labelledby="quiz-h" className="flex flex-col gap-3">
      <h2 id="quiz-h" className="text-lg font-semibold">
        Quiz
      </h2>
      {quizId ? (
        <>
          <QuizRunner quizId={quizId} onOpen={onOpen} />
          <Button variant="ghost" onClick={() => setQuizId(null)} className="self-start">
            End quiz
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-4 rounded-lg bg-raised p-6 shadow-raised-sm">
          <p className="text-sm text-secondary">
            You answer first; the grade and feedback cite the passage they rely on. Arithmetic is
            computed with mathjs, never by the model.
          </p>
          {topics.length > 0 && (
            <fieldset>
              <legend className="text-sm font-medium">Topics (none = all, weakest first)</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {topics.slice(0, 20).map((t) => (
                  <label
                    key={t}
                    className={cls(
                      "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs",
                      picked.includes(t)
                        ? "bg-accent-soft text-primary"
                        : "bg-layer-subtle text-secondary",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(t)}
                      disabled={!picked.includes(t) && picked.length >= 10}
                      onChange={() =>
                        setPicked((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))
                      }
                      className="size-3.5 accent-[var(--accent-strong)]"
                    />
                    {t}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="mb-1 text-sm font-medium">Difficulty</legend>
            {(["easy", "medium", "hard"] as const).map((d) => (
              <label
                key={d}
                className={cls(
                  "inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm capitalize",
                  difficulty === d
                    ? "bg-accent-soft text-primary"
                    : "bg-layer-subtle text-secondary",
                )}
              >
                <input
                  type="radio"
                  name="difficulty"
                  value={d}
                  checked={difficulty === d}
                  onChange={() => setDifficulty(d)}
                  className="sr-only"
                />
                {d}
              </label>
            ))}
          </fieldset>
          <Toggle label="Multiple choice" checked={multipleChoice} onChange={setMultipleChoice} />
          <Toggle
            label="Exam-grade"
            description={
              n.localOnly
                ? "Not available: this notebook is local only."
                : "Write and grade with the strongest API model. Needs an API key; counts toward the budget."
            }
            checked={examGrade && !n.localOnly}
            disabled={n.localOnly}
            onChange={setExamGrade}
          />
          {create.error && (
            <p role="alert" className="text-sm text-danger">
              {create.error.message}
            </p>
          )}
          <Button
            variant="primary"
            disabled={create.isPending || n.sourceCount === 0}
            onClick={() => create.mutate()}
            className="self-start"
          >
            Start quiz
          </Button>
          {n.sourceCount === 0 && (
            <p className="text-xs text-secondary">Add sources to this notebook first.</p>
          )}
        </div>
      )}
    </section>
  );
}

const KIND_LABEL = { exam: "Exam", commitment: "Due", event: "Event" } as const;

/** Deadlines with the lectures most related to each (embedding similarity within the notebook). */
function Workload({ notebookId }: { notebookId: string }) {
  const q = useQuery({
    queryKey: ["workload", notebookId],
    queryFn: () => api.workload(notebookId),
  });
  return (
    <section aria-labelledby="workload-h">
      <h2 id="workload-h" className="text-lg font-semibold">
        Deadlines and workload
      </h2>
      {q.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {q.error.message}
        </p>
      )}
      {q.data?.items.length === 0 && (
        <p className="mt-2 text-sm text-secondary">
          Nothing due. Exams, commitments and calendar events in this notebook show up here.
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {q.data?.items.map((i) => (
          <li
            key={`${i.kind}-${i.title}-${i.due}`}
            className="rounded-lg bg-raised px-4 py-3 shadow-raised-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={i.kind === "exam" ? "accent" : "neutral"}>{KIND_LABEL[i.kind]}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
              <span className="tabular text-xs text-secondary">
                {new Date(i.due).toLocaleDateString(undefined, { dateStyle: "medium" })} ·{" "}
                {daysLabel(daysUntil(i.due))}
              </span>
            </div>
            {i.related.length > 0 && (
              <p className="mt-1 text-xs text-secondary">
                Related: {i.related.map((r) => r.title).join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Mind map tab: build (a study job), then the lazily loaded xyflow view. */
export function MindMapTab({ notebook: n, onOpen }: { notebook: Notebook; onOpen: Open }) {
  const q = useQuery({ queryKey: ["mindmap", n.id], queryFn: () => api.mindMap(n.id) });
  const job = useStudyJob(n.id, "mindmap");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <p className="mr-auto max-w-prose text-sm text-secondary">
          Up to 60 concepts from this notebook. Every concept links to the passages it comes from.
        </p>
        <JobButton
          job={job}
          label={q.data?.mindmap ? "Rebuild" : "Build mind map"}
          variant={q.data?.mindmap ? "secondary" : "primary"}
        />
      </div>
      {q.error && (
        <p role="alert" className="text-sm text-danger">
          {q.error.message}
        </p>
      )}
      {q.data?.mindmap && q.data.mindmap.nodes.length > 0 ? (
        <Suspense
          fallback={
            <div aria-hidden className="h-[520px] animate-pulse rounded-lg bg-layer-subtle" />
          }
        >
          <MindMapView map={q.data.mindmap} onOpen={onOpen} />
        </Suspense>
      ) : (
        q.data && (
          <p className="rounded-lg bg-raised p-8 text-center text-sm text-secondary shadow-raised-sm">
            No mind map yet.
          </p>
        )
      )}
      {q.data?.mindmap && q.data.mindmap.nodes.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-secondary">Concepts as a list</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {q.data.mindmap.nodes.map((node) => (
              <li key={node.id}>
                {node.label} <Citations citations={node.citations} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Exports tab: the verified study guide (view, Markdown, print to PDF) and the Anki deck. */
export function ExportsTab({ notebook: n, onOpen }: { notebook: Notebook; onOpen: Open }) {
  const q = useQuery({ queryKey: ["guide", n.id], queryFn: () => api.studyGuide(n.id) });
  const job = useStudyJob(n.id, "guide");
  const guide = q.data?.guide;
  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="anki-h"
        className="no-print rounded-lg bg-raised p-6 shadow-raised-sm"
      >
        <h2 id="anki-h" className="text-lg font-semibold">
          Anki deck
        </h2>
        <p className="mt-1 text-sm text-secondary">
          A semicolon-separated text file. In Anki desktop: File, Import, then pick the file. Tags
          follow rocky::notebook::topic.
        </p>
        <a
          href={api.exportUrl(n.id, "anki")}
          download
          aria-disabled={n.cardCount === 0}
          className={cls(linkButton, "mt-3", n.cardCount === 0 && "pointer-events-none opacity-50")}
        >
          <Download size={16} aria-hidden /> Download {n.cardCount} card
          {n.cardCount === 1 ? "" : "s"}
        </a>
      </section>

      <SourcePack notebookId={n.id} />

      <section aria-labelledby="guide-h" className="flex flex-col gap-4">
        <div className="no-print flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 id="guide-h" className="text-lg font-semibold">
              Study guide
            </h2>
            <p className="text-sm text-secondary">
              Sections per topic. Every sentence is checked against its source; unsupported ones are
              left out.
            </p>
          </div>
          <JobButton
            job={job}
            label={guide ? "Rebuild" : "Build study guide"}
            variant={guide ? "secondary" : "primary"}
          />
          {guide && (
            <>
              <a href={api.exportUrl(n.id, "md")} download className={linkButton}>
                <Download size={16} aria-hidden /> Markdown
              </a>
              <Button onClick={() => window.print()}>
                <Printer size={16} aria-hidden /> Print or PDF
              </Button>
            </>
          )}
        </div>
        {q.error && (
          <p role="alert" className="text-sm text-danger">
            {q.error.message}
          </p>
        )}
        {guide && (
          <article className="print-guide rounded-lg bg-raised p-8 shadow-raised-sm">
            <h1 className="font-display text-2xl leading-8">{guide.title}</h1>
            <p className="text-xs text-secondary">
              Built{" "}
              {new Date(guide.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
            {guide.sections.map((s) => (
              <section key={s.topic} className="mt-6">
                <h2 className="text-lg font-semibold capitalize">{s.topic}</h2>
                <p className="mt-2 font-answer text-base leading-[26px]">
                  {s.sentences.map((t, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sentences are static once built
                    <span key={i}>
                      {t.text} <Citations citations={t.citations} onOpen={onOpen} />{" "}
                    </span>
                  ))}
                </p>
              </section>
            ))}
            {guide.sections.length === 0 && (
              <p className="mt-4 text-sm text-secondary">
                Nothing could be verified against the sources, so the guide is empty.
              </p>
            )}
          </article>
        )}
        {q.data && !guide && (
          <p className="rounded-lg bg-raised p-8 text-center text-sm text-secondary shadow-raised-sm">
            No study guide yet.
          </p>
        )}
      </section>
    </div>
  );
}

/** Drive source pack: this week of the course as one Google Doc, queued for approval. */
function SourcePack({ notebookId }: { notebookId: string }) {
  const qc = useQueryClient();
  const pack = useMutation({
    mutationFn: () => assistant.sourcePack(notebookId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["actions"] }),
  });
  return (
    <section
      aria-labelledby="pack-h"
      className="no-print rounded-lg bg-raised p-6 shadow-raised-sm"
    >
      <h2 id="pack-h" className="text-lg font-semibold">
        Drive source pack
      </h2>
      <p className="mt-1 text-sm text-secondary">
        This week's lectures and sources as one Google Doc in a "Rocky source packs" folder in your
        Drive. You can add that folder to NotebookLM yourself; Rocky does not use NotebookLM.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={pack.isPending} onClick={() => pack.mutate()}>
          <Upload size={16} aria-hidden /> Prepare this week's pack
        </Button>
        {pack.isSuccess && (
          <span className="text-sm">
            Waiting for your approval in <Link to="/actions">Actions</Link>.
          </span>
        )}
      </div>
      {pack.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {pack.error.message}
        </p>
      )}
    </section>
  );
}

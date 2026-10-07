import type {
  Card,
  Citation,
  Countdown,
  JobEvent,
  QuizGrade,
  QuizQuestion,
  Rating,
} from "@rocky/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Loader, RotateCcw, Sigma } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, type StudyTask, watchJob } from "../api.ts";
import { daysLabel, RATINGS, ratingForKey, weaknessWord } from "../study.ts";
import { SafeText } from "./SafeText.tsx";
import { CitationChip } from "./trust.tsx";
import { Badge, Button, cls } from "./ui.tsx";

/** Progress ring (DESIGN screen 3): share of mature cards. Decorative; the label carries the number. */
export function ProgressRing({ value, size = 40 }: { value: number; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex items-center justify-center" title="Mastered cards">
      <svg width={size} height={size} aria-hidden className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={4}
          className="stroke-sunken"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          className="stroke-accent-strong"
        />
      </svg>
      <span className="tabular absolute text-[11px] font-medium text-secondary">
        {Math.round(value * 100)}%
      </span>
      <span className="sr-only">mastered</span>
    </span>
  );
}

const STUDY_KEYS: Record<StudyTask, string[][]> = {
  cards: [["cards"], ["review"], ["notebooks"], ["notebook"]],
  summaries: [["guide"]],
  guide: [["guide"]],
  mindmap: [["mindmap"]],
};

/**
 * Starts a study job (cards, summaries, guide, mind map) and follows it over SSE. The daemon
 * dedupes a task that is already queued, so a second click just re-attaches.
 */
export function useStudyJob(notebookId: string, task: StudyTask) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [ev, setEv] = useState<JobEvent | null>(null);
  const start = useMutation({
    mutationFn: () => api.studyJob(notebookId, task),
    onSuccess: (r) => {
      setEv(null);
      setJobId(r.jobId);
    },
  });
  useEffect(() => {
    if (!jobId) return;
    return watchJob(jobId, (e) => {
      setEv(e);
      if (e.status === "done" || e.status === "failed") {
        setJobId(null);
        for (const key of STUDY_KEYS[task]) void qc.invalidateQueries({ queryKey: key });
      }
    });
  }, [jobId, qc, task]);
  const running = start.isPending || jobId !== null;
  return {
    start: () => start.mutate(),
    running,
    event: ev,
    error: start.error?.message ?? (ev?.status === "failed" ? (ev.error ?? "Job failed") : null),
  };
}

/** Button plus live progress line for a study job. */
export function JobButton({
  job,
  label,
  variant = "secondary",
}: {
  job: ReturnType<typeof useStudyJob>;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const p = job.event?.progress;
  return (
    <div className="flex flex-col gap-1">
      <Button variant={variant} disabled={job.running} onClick={job.start}>
        {job.running && (
          <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
        )}
        {label}
      </Button>
      <span aria-live="polite" className="tabular min-h-4 text-xs text-secondary">
        {job.running &&
          (p !== null && p !== undefined
            ? `${job.event?.note ?? "Working"} · ${Math.round(p * 100)}%`
            : "Queued; local models can take a few minutes.")}
        {!job.running && job.event?.status === "done" && "Done."}
      </span>
      {job.error && (
        <p role="alert" className="text-xs text-danger">
          {job.error}
        </p>
      )}
    </div>
  );
}

export function Citations({
  citations,
  onOpen,
}: {
  citations: Citation[];
  onOpen: (c: Citation) => void;
}) {
  if (!citations.length) return null;
  return (
    <span>
      {citations.map((c, i) => (
        <CitationChip key={`${c.chunkId}:${c.quote}`} index={i + 1} citation={c} onOpen={onOpen} />
      ))}
    </span>
  );
}

/**
 * Centered 560 x 340 card that flips (DESIGN screen 4). Space flips, 1–4 rate after the flip.
 * The flip is a crossfade-free rotate; reduced motion removes it via the global override.
 */
export function Flashcard({
  card,
  onRate,
  busy,
  onOpen,
}: {
  card: Card;
  onRate: (r: Rating) => void;
  busy: boolean;
  onOpen: (c: Citation) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new card starts face up
  useEffect(() => setFlipped(false), [card.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " ") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && !busy) {
        const r = ratingForKey(e.key);
        if (r) onRate(r);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, busy, onRate]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-[560px] [perspective:1200px]">
        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          aria-label={flipped ? "Show question" : "Show answer"}
          className={cls(
            "relative h-[340px] w-full rounded-lg text-left [transform-style:preserve-3d]",
            "transition-transform duration-[var(--dur-flip)] ease-out",
            flipped && "[transform:rotateY(180deg)]",
          )}
        >
          <Face label={card.topic ?? "Question"} hidden={flipped}>
            <p className="text-xl leading-8 text-primary">{card.front}</p>
            <p className="mt-auto text-xs text-tertiary">Space to flip</p>
          </Face>
          <Face label="Answer" hidden={!flipped} back>
            <p className="text-lg leading-7 text-primary">{card.back}</p>
          </Face>
        </button>
      </div>
      {flipped && card.citation && (
        <p className="text-xs text-secondary">
          Source <Citations citations={[card.citation]} onOpen={onOpen} />
        </p>
      )}
      <fieldset
        aria-label="How well did you know it?"
        className={cls("flex flex-wrap justify-center gap-2", !flipped && "invisible")}
      >
        {RATINGS.map((r) => (
          <Button
            key={r.rating}
            variant={r.rating === "good" ? "primary" : "secondary"}
            disabled={busy || !flipped}
            onClick={() => onRate(r.rating)}
            className="min-w-24"
          >
            {r.label}
            <kbd className="text-xs font-normal opacity-70">{r.key}</kbd>
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

function Face({
  label,
  hidden,
  back,
  children,
}: {
  label: string;
  hidden: boolean;
  back?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden={hidden}
      className={cls(
        "absolute inset-0 flex flex-col gap-3 overflow-auto rounded-lg bg-raised p-8 shadow-raised-md [backface-visibility:hidden]",
        back && "[transform:rotateY(180deg)]",
      )}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-secondary">{label}</span>
      {children}
    </span>
  );
}

/** Answer-first quiz (DESIGN screen 4): the student commits an answer, then sees cited grading. */
export function QuizRunner({ quizId, onOpen }: { quizId: string; onOpen: (c: Citation) => void }) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [grade, setGrade] = useState<QuizGrade | null>(null);
  const [score, setScore] = useState<{ total: number; n: number }>({ total: 0, n: 0 });
  const next = useMutation({
    mutationFn: () => api.nextQuestion(quizId),
    onSuccess: (q) => {
      setQuestion(q);
      setAnswer("");
      setGrade(null);
    },
  });
  const submit = useMutation({
    mutationFn: () => {
      if (!question) throw new Error("No question");
      return api.answerQuestion(quizId, question.id, answer);
    },
    onSuccess: (g) => {
      setGrade(g);
      setScore((s) => ({ total: s.total + g.grade, n: s.n + 1 }));
      void qc.invalidateQueries({ queryKey: ["countdown"] });
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: load the first question once per quiz
  useEffect(() => next.mutate(), [quizId]);

  const error = next.error ?? submit.error;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
      {score.n > 0 && (
        <p className="tabular text-sm text-secondary">
          {score.n} answered · average {Math.round((score.total / score.n) * 100)}%
        </p>
      )}
      {next.isPending && (
        <div className="flex h-48 items-center justify-center rounded-lg bg-raised p-8 shadow-raised-sm">
          <p className="flex items-center gap-2 text-sm text-secondary">
            <Loader size={16} aria-hidden className="animate-spin motion-reduce:animate-none" />
            Writing a question from your sources…
          </p>
        </div>
      )}
      {question && !next.isPending && (
        <section
          aria-label="Question"
          className="flex flex-col gap-4 rounded-lg bg-raised p-8 shadow-raised-md"
        >
          <Badge tone="accent">{question.topic}</Badge>
          <h2 className="text-xl font-normal leading-8 text-primary">{question.question}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim() && !grade) submit.mutate();
            }}
            className="flex flex-col gap-3"
          >
            {question.options ? (
              <fieldset
                className="flex flex-col gap-2"
                disabled={Boolean(grade) || submit.isPending}
              >
                <legend className="sr-only">Options</legend>
                {question.options.map((o) => (
                  <label
                    key={o}
                    className={cls(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-4 py-2 text-sm",
                      answer === o ? "bg-accent-soft" : "bg-layer-faint hover:bg-layer-subtle",
                    )}
                  >
                    <input
                      type="radio"
                      name="quiz-option"
                      value={o}
                      checked={answer === o}
                      onChange={() => setAnswer(o)}
                      className="size-4 accent-[var(--accent-strong)]"
                    />
                    {o}
                  </label>
                ))}
              </fieldset>
            ) : (
              <>
                <label htmlFor="quiz-answer" className="text-sm font-medium">
                  Your answer
                </label>
                <textarea
                  id="quiz-answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  readOnly={Boolean(grade)}
                  rows={4}
                  maxLength={4000}
                  className="rounded-md border border-border-strong bg-page p-3 text-sm"
                />
              </>
            )}
            {!grade && (
              <Button
                type="submit"
                variant="primary"
                disabled={!answer.trim() || submit.isPending}
                className="self-start"
              >
                {submit.isPending ? "Grading…" : "Check answer"}
              </Button>
            )}
          </form>
        </section>
      )}
      {grade && <GradeView grade={grade} onOpen={onOpen} />}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ApiError && error.code === "EGRESS_BLOCKED"
            ? `${error.message} Turn off exam-grade mode, or turn off local-only for this notebook.`
            : error.message}
        </p>
      )}
      {(grade || error) && (
        <Button onClick={() => next.mutate()} disabled={next.isPending} className="self-start">
          <RotateCcw size={16} aria-hidden /> Next question
        </Button>
      )}
    </div>
  );
}

function GradeView({ grade, onOpen }: { grade: QuizGrade; onOpen: (c: Citation) => void }) {
  const pct = Math.round(grade.grade * 100);
  const good = grade.grade >= 0.7;
  return (
    <section
      aria-label="Feedback"
      className="flex flex-col gap-3 rounded-lg bg-raised p-6 shadow-raised-sm"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        {good ? (
          <CircleCheck size={16} aria-hidden className="text-success" />
        ) : (
          <CircleAlert size={16} aria-hidden className="text-warning" />
        )}
        <span className="tabular">{pct}%</span> {good ? "Correct" : "Not quite"}
      </p>
      <p className="text-sm leading-6 text-primary">
        <SafeText text={grade.feedback} /> <Citations citations={grade.citations} onOpen={onOpen} />
      </p>
      {grade.computations.length > 0 && (
        <ul aria-label="Computed with mathjs" className="flex flex-col gap-1">
          {grade.computations.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Sigma size={14} aria-hidden className="text-accent-strong" />
              <code className="font-mono text-xs text-secondary">{c.expr}</code>
              {c.value !== null ? (
                <span className="tabular font-medium">= {c.value}</span>
              ) : (
                <span className="text-warning">
                  This step needs a computer algebra system; not computed.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-secondary">Reference answer</summary>
        <p className="mt-2 text-primary">
          <SafeText text={grade.referenceAnswer} />
        </p>
      </details>
    </section>
  );
}

/** Compact exam countdown (DESIGN screen 4): days left, weakest topics, today's plan. */
export function CountdownCard({ data }: { data: Countdown }) {
  const weak = data.topics.slice(0, 5);
  return (
    <section aria-label="Exam countdown" className="rounded-lg bg-raised p-6 shadow-raised-sm">
      {data.exam && data.daysLeft !== null ? (
        <div className="flex items-baseline gap-3">
          <span className="tabular font-display text-4xl text-primary">{data.daysLeft}</span>
          <span className="text-sm text-secondary">
            day{data.daysLeft === 1 ? "" : "s"} to {data.exam.title} (
            {new Date(data.exam.at).toLocaleDateString(undefined, { dateStyle: "medium" })},{" "}
            {daysLabel(data.daysLeft)})
          </span>
        </div>
      ) : (
        <p className="text-sm text-secondary">
          No exam date yet. Add one in the notebook settings.
        </p>
      )}
      {weak.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Weakest topics</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {weak.map((t) => (
              <li key={t.topic} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{t.topic}</span>
                <span className="h-1 w-24 overflow-hidden rounded-full bg-sunken" aria-hidden>
                  <span
                    className={cls(
                      "block h-full rounded-full",
                      t.weakness >= 0.6
                        ? "bg-danger"
                        : t.weakness >= 0.35
                          ? "bg-warning"
                          : "bg-success",
                    )}
                    style={{ width: `${t.weakness * 100}%` }}
                  />
                </span>
                <span className="w-12 text-xs text-secondary">{weaknessWord(t.weakness)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-4 text-sm text-primary">
        Today: review {data.plan.cards} card{data.plan.cards === 1 ? "" : "s"}
        {data.plan.quizTopics.length > 0 &&
          `, then one quiz on ${data.plan.quizTopics.join(" and ")}`}
        .
      </p>
    </section>
  );
}

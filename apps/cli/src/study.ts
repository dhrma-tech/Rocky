import { createInterface, type Interface } from "node:readline/promises";
import type { Card, Notebook, Rating } from "@rocky/contracts";
import {
  answerQuestion,
  createQuiz,
  listNotebooks,
  nextQuestion,
  openRuntime,
  type Runtime,
  resolveDataDir,
  reviewCard,
  reviewQueue,
} from "@rocky/core";

/** Terminal I/O for a study session; `ask` returns null at end of input. */
export interface StudyIo {
  out: (s: string) => void;
  ask: (q: string) => Promise<string | null>;
}

const RATINGS: Record<string, Rating> = { "1": "again", "2": "hard", "3": "good", "4": "easy" };

export function findNotebook(rt: Runtime, ref: string): Notebook {
  const all = listNotebooks(rt.db);
  const exact = all.find((n) => n.id === ref || n.name.toLowerCase() === ref.toLowerCase());
  if (exact) return exact;
  const partial = all.filter((n) => n.name.toLowerCase().includes(ref.toLowerCase()));
  if (partial.length === 1 && partial[0]) return partial[0];
  throw new Error(
    partial.length
      ? `"${ref}" matches ${partial.map((n) => n.name).join(", ")}.`
      : `No notebook "${ref}". See: rocky notebooks list`,
  );
}

const source = (c: Card) =>
  c.citation ? `\n  (source: ${c.citation.title}: "${c.citation.quote.slice(0, 160)}")` : "";

/** Spaced-repetition review in the terminal: show the front, reveal, rate 1–4 (SM-2). */
export async function runReview(
  rt: Runtime,
  notebookId: string | undefined,
  io: StudyIo,
): Promise<number> {
  const q = reviewQueue(rt.db, { notebookId });
  if (!q.cards.length) {
    io.out("Nothing to review right now.");
    return 0;
  }
  io.out(`${q.dueToday} due, ${q.newToday} new. Enter reveals the answer; q quits.\n`);
  let done = 0;
  for (const card of q.cards) {
    io.out(`Q: ${card.front}${card.isNew ? "  [new]" : ""}`);
    const reveal = await io.ask("  (Enter to show) ");
    if (reveal === null || reveal.trim().toLowerCase() === "q") break;
    io.out(`A: ${card.back}${source(card)}`);
    let rating: Rating | undefined;
    while (!rating) {
      const a = await io.ask("  1 again · 2 hard · 3 good · 4 easy > ");
      if (a === null || a.trim().toLowerCase() === "q") {
        io.out(`\nReviewed ${done} card(s).`);
        return 0;
      }
      rating = RATINGS[a.trim()];
    }
    const next = reviewCard(rt.db, card.id, rating);
    done++;
    io.out(`  next in ${next.intervalDays} day(s)\n`);
  }
  io.out(`Reviewed ${done} card(s).`);
  return 0;
}

/** A short quiz from the notebook's sources, graded with cited feedback. */
export async function runQuiz(
  rt: Runtime,
  nb: Notebook,
  opts: { questions: number; difficulty: "easy" | "medium" | "hard" },
  io: StudyIo,
): Promise<number> {
  const deps = { db: rt.db, router: rt.router, embedder: rt.embedder };
  const { id } = createQuiz(rt.db, { notebookId: nb.id, difficulty: opts.difficulty });
  let total = 0;
  let n = 0;
  for (; n < opts.questions; n++) {
    io.out(`\nWriting question ${n + 1} of ${opts.questions}…`);
    const q = await nextQuestion(deps, id);
    io.out(`\n${n + 1}. ${q.question}`);
    for (const [i, o] of (q.options ?? []).entries())
      io.out(`   ${String.fromCharCode(97 + i)}) ${o}`);
    const answer = await io.ask("> ");
    if (answer === null || answer.trim().toLowerCase() === "q") break;
    if (!answer.trim()) {
      io.out("Skipped.");
      continue;
    }
    const g = await answerQuestion(deps, id, q.id, answer.trim());
    total += g.grade;
    io.out(`\nScore ${Math.round(g.grade * 100)}%. ${g.feedback}`);
    io.out(`Reference: ${g.referenceAnswer}`);
    for (const c of g.citations) io.out(`  - ${c.title}: "${c.quote.slice(0, 160)}"`);
  }
  if (n) io.out(`\nAverage ${Math.round((total / n) * 100)}% over ${n} question(s).`);
  return 0;
}

export async function studyCommand(
  notebook: string | undefined,
  opts: {
    dataDir?: string | undefined;
    quiz?: boolean;
    questions?: string;
    difficulty?: string;
  },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  let rl: Interface | undefined;
  try {
    const nb = notebook ? findNotebook(rt, notebook) : undefined;
    if (!process.stdin.isTTY) {
      // Headless: report what is due rather than wait on input that will never come.
      const q = reviewQueue(rt.db, { notebookId: nb?.id });
      console.log(`${q.dueToday} card(s) due and ${q.newToday} new${nb ? ` in ${nb.name}` : ""}.`);
      return 0;
    }
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const r = rl;
    let closed = false;
    r.once("close", () => {
      closed = true;
    });
    const io: StudyIo = {
      out: (s) => console.log(s),
      ask: async (q) => (closed ? null : r.question(q).catch(() => null)),
    };
    if (opts.quiz) {
      if (!nb) throw new Error("A quiz needs a notebook: rocky study <notebook> --quiz");
      const difficulty = (["easy", "medium", "hard"] as const).find((d) => d === opts.difficulty);
      return await runQuiz(
        rt,
        nb,
        {
          questions: Math.min(Math.max(Number(opts.questions ?? 5) || 5, 1), 20),
          difficulty: difficulty ?? "medium",
        },
        io,
      );
    }
    return await runReview(rt, nb?.id, io);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    rl?.close();
    rt.close();
  }
}

import type { AnswerSentence } from "@rocky/contracts";
import {
  briefForEvent,
  briefForNotebook,
  listNotebooks,
  listRoutines,
  openRuntime,
  resolveDataDir,
  runRoutine,
} from "@rocky/core";

/** Sentences with numbered sources underneath, for the terminal. */
function printAnswer(answer: AnswerSentence[]): void {
  const sources = new Map<string, { n: number; title: string; quote: string }>();
  const text = answer
    .map((s) => {
      const marks = s.citations.map((c) => {
        if (!sources.has(c.chunkId))
          sources.set(c.chunkId, { n: sources.size + 1, title: c.title, quote: c.quote });
        return `[${sources.get(c.chunkId)?.n}]`;
      });
      return `${s.text} ${marks.join("")}${s.status === "partial" ? " (partially supported)" : ""}`;
    })
    .join(" ");
  console.log(text);
  if (sources.size) console.log("");
  for (const s of sources.values()) console.log(`  [${s.n}] ${s.title}: "${s.quote}"`);
}

const when = (ms: number) => new Date(ms).toLocaleString();

/** `rocky brief <event document id | notebook id or name>`: a cited brief before a meeting or class. */
export async function briefCommand(
  subject: string,
  opts: { dataDir?: string | undefined },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    const deps = { db: rt.db, router: rt.router, embedder: rt.embedder };
    const isEvent = rt.db
      .prepare("select 1 from documents where id = ? and source_type = 'calendar'")
      .get(subject);
    const nb = isEvent
      ? undefined
      : listNotebooks(rt.db).find(
          (n) => n.id === subject || n.name.toLowerCase() === subject.toLowerCase(),
        );
    if (!isEvent && !nb) {
      console.error(
        "No calendar event or notebook with that id or name. List notebooks: rocky notebooks list",
      );
      return 1;
    }
    const b = isEvent
      ? await briefForEvent(deps, subject)
      : await briefForNotebook(deps, nb?.id as string);
    console.log(`${b.title}${b.startsAt ? `, ${when(b.startsAt)}` : ""}\n`);
    for (const f of b.facts)
      console.log(
        `  ${f.label}${f.at ? ` ${new Date(f.at).toISOString().slice(0, 10)}` : ""}: ${f.detail}`,
      );
    if (b.facts.length) console.log("");
    if (b.notFound) console.log("Nothing in your sources for this brief yet.");
    else printAnswer(b.answer);
    if (b.path) console.log(`\n(${b.path.local ? "local" : "API"} · ${b.path.model})`);
    return 0;
  } finally {
    rt.close();
  }
}

/** `rocky routines list | run <id or name>`. */
export async function routinesCommand(
  action: string,
  arg: string | undefined,
  opts: { dataDir?: string | undefined },
): Promise<number> {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    const all = listRoutines(rt.db, { dataDir: rt.dataDir });
    if (action === "list") {
      for (const r of all)
        console.log(
          `${r.id}  ${r.name.padEnd(18)} ${r.schedule.padEnd(14)} ${r.enabled ? "on " : "off"}` +
            (r.nextRunAt ? `  next ${when(r.nextRunAt)}` : "") +
            (r.lastRun ? `  last ${when(r.lastRun.startedAt)} (${r.lastRun.status})` : ""),
        );
      if (!all.length) console.log("No routines.");
      return 0;
    }
    if (action === "run") {
      const r = all.find((x) => x.id === arg || x.name.toLowerCase() === arg?.toLowerCase());
      if (!r) {
        console.error("Usage: rocky routines run <id or name> (see rocky routines list)");
        return 1;
      }
      const run = await runRoutine({ db: rt.db, router: rt.router, dataDir: rt.dataDir }, r.id);
      if (run.status === "failed") {
        console.error(`Failed: ${run.error}`);
        return 1;
      }
      console.log(`${r.name}, ${when(run.startedAt)}\n`);
      if (run.notFound) console.log("Nothing to report from your sources.");
      else printAnswer(run.answer);
      return 0;
    }
    console.error("Usage: rocky routines list | run <id or name>");
    return 1;
  } finally {
    rt.close();
  }
}

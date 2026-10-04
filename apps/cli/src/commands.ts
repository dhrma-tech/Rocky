import fs from "node:fs";
import path from "node:path";
import type { AskResult } from "@rocky/contracts";
import {
  ask,
  type EvalReport,
  ingestPath,
  loadEvalSet,
  openRuntime,
  repoConfigDir,
  resolveDataDir,
  runEval,
} from "@rocky/core";

const repoRoot = path.resolve(repoConfigDir, "..");

export async function ingestCommand(target: string, opts: { dataDir?: string | undefined }) {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    const results = await ingestPath(rt.db, rt.paths.blobs, target);
    const counts = new Map<string, number>();
    for (const r of results) {
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      if (r.status === "skipped") console.error(`skipped ${r.path}: ${r.reason}`);
    }
    console.log([...counts].map(([s, n]) => `${n} ${s}`).join(", ") || "no supported files found");
    const n = await rt.drainJobs((m) => console.error(m));
    if (n) console.log(`embedded ${n} document(s)`);
    return 0;
  } finally {
    rt.close();
  }
}

export function formatAnswer(r: AskResult): string {
  const lines: string[] = [];
  if (r.notFound) {
    lines.push("Not found in your sources.");
    if (r.closestMatches.length)
      lines.push(`Closest matches: ${r.closestMatches.map((m) => m.title).join("; ")}`);
  }
  const refs = new Map<string, number>();
  for (const s of r.answer) {
    const marks = s.citations.map((c) => {
      if (!refs.has(c.chunkId)) refs.set(c.chunkId, refs.size + 1);
      return `[${refs.get(c.chunkId)}]`;
    });
    const flag =
      s.status === "partial"
        ? " (partially supported)"
        : s.status === "unsupported"
          ? " (FLAGGED)"
          : "";
    lines.push(`${s.text} ${marks.join("")}${flag}`);
  }
  if (refs.size) {
    lines.push("");
    const seen = new Set<string>();
    for (const s of r.answer)
      for (const c of s.citations) {
        if (seen.has(c.chunkId)) continue;
        seen.add(c.chunkId);
        const where = c.anchor.kind === "pdf_page" ? `, p. ${c.anchor.page}` : "";
        lines.push(`[${refs.get(c.chunkId)}] ${c.title}${where}: "${c.quote}"`);
      }
  }
  const p = r.path;
  if (p) {
    const fb = p.fallbackReason ? ` (fallback: ${p.fallbackReason})` : "";
    lines.push(
      "",
      `${p.local ? "local" : "api"} · ${p.model}${fb} · $${r.usage.costUsd.toFixed(4)}`,
    );
    if (p.local && !r.notFound) lines.push("verified locally (lower confidence)");
  }
  if (r.verifierError) lines.push(`verifier unavailable: ${r.verifierError}`);
  return lines.join("\n");
}

export async function askCommand(
  question: string,
  opts: {
    dataDir?: string | undefined;
    localOnly?: boolean;
    showFlagged?: boolean;
    json?: boolean;
  },
) {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const rt = await openRuntime({ dataDir: dir, localOnly: Boolean(opts.localOnly) });
  try {
    const r = await ask(
      { db: rt.db, router: rt.router, embedder: rt.embedder },
      {
        question,
        scope: { localOnly: Boolean(opts.localOnly) },
        showFlagged: Boolean(opts.showFlagged),
      },
    );
    console.log(opts.json ? JSON.stringify(r, null, 2) : formatAnswer(r));
    return 0;
  } finally {
    rt.close();
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(r: EvalReport): string {
  const lines = r.results.map((q) => {
    const hit = q.hitAt5 === null ? " - " : q.hitAt5 ? "hit" : "MISS";
    const valid = q.shown ? `${q.valid}/${q.shown}` : "-";
    const status = q.error
      ? `ERROR ${q.error.slice(0, 80)}`
      : q.answerable
        ? q.notFound
          ? "NOT FOUND"
          : `correct ${q.correctness ?? 0}`
        : q.notFound
          ? "abstained"
          : "ANSWERED (should abstain)";
    return `  ${q.id.padEnd(6)} ${hit.padEnd(4)} valid ${valid.padEnd(5)} ${status}`;
  });
  const g = (k: keyof EvalReport["gates"], label: string) => {
    const x = r.gates[k];
    if (x.skipped) return `  n/a  ${label.padEnd(18)} nothing to measure in this subset`;
    return `  ${x.pass ? "PASS" : "FAIL"} ${label.padEnd(18)} ${pct(x.value)} (min ${pct(x.min)})`;
  };
  return [
    `Eval "${r.set}": ${r.questions} questions`,
    ...lines,
    "",
    g("hitAt5", "hit@5"),
    g("citationValidity", "citation validity"),
    g("abstention", `abstention ${r.abstention.correct}/${r.abstention.total}`),
    `  info answer correctness ${pct(r.correctness)}`,
    `  cost $${r.usage.costUsd.toFixed(4)}`,
    "",
    r.pass ? "Phase 1 gates passed." : "Phase 1 gates NOT met.",
  ].join("\n");
}

export async function evalCommand(opts: {
  dataDir?: string | undefined;
  set: string;
  localOnly?: boolean;
  fresh?: boolean;
  limit?: string;
  json?: boolean;
}) {
  const setDir = path.join(repoRoot, "evals", opts.set);
  const questionsFile = path.join(setDir, "questions.yaml");
  const corpus = path.join(setDir, "corpus");
  if (!fs.existsSync(questionsFile) || !fs.existsSync(corpus)) {
    console.error(`Eval set not found: expected ${questionsFile} and ${corpus}/`);
    return 2;
  }
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  // Evals use their own DB so your own documents never skew retrieval.
  const dbFile = path.join(dir, "evals", `${opts.set}.db`);
  if (opts.fresh)
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  const rt = await openRuntime({ dataDir: dir, dbFile, localOnly: Boolean(opts.localOnly) });
  try {
    await ingestPath(rt.db, rt.paths.blobs, corpus);
    await rt.drainJobs((m) => console.error(m));
    let questions = loadEvalSet(questionsFile);
    if (opts.limit) questions = questions.slice(0, Number(opts.limit));
    const report = await runEval(rt, opts.set, questions, {
      localOnly: Boolean(opts.localOnly),
      onProgress: (q, i) => console.error(`[${i + 1}/${questions.length}] ${q.id}`),
    });
    const out = path.join(dir, "evals", `${opts.set}-${report.at.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
    console.error(`report: ${out}`);
    return report.pass ? 0 : 1;
  } finally {
    rt.close();
  }
}

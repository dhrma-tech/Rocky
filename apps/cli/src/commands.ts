import fs from "node:fs";
import path from "node:path";
import type { AskResult } from "@rocky/contracts";
import {
  addWatchedFolder,
  ask,
  dataPaths,
  type EvalReport,
  ingestPath,
  keychainSecrets,
  listWatchedFolders,
  loadEvalSet,
  openDb,
  openRuntime,
  removeWatchedFolder,
  repoConfigDir,
  resolveDataDir,
  runEval,
  verifyAuditChain,
  type WatchedFolder,
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

export async function daemonCommand(opts: { dataDir?: string | undefined; port?: string }) {
  const { startDaemon } = await import("@rocky/daemon");
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const d = await startDaemon({ dataDir: dir, ...(opts.port ? { port: Number(opts.port) } : {}) });
  console.log(
    `Rocky daemon on ${d.url}. Run \`rocky open\` to sign in the browser. Ctrl+C stops it.`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await d.stop();
  return 0;
}

/** Mints a one-time sign-in code from the running daemon and prints the bootstrap URL. */
export async function openCommand(opts: { dataDir?: string | undefined }) {
  const { daemonInfoFile } = await import("@rocky/daemon");
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const infoFile = daemonInfoFile(dir);
  if (!fs.existsSync(infoFile)) {
    console.error("The daemon is not running. Start it with `rocky daemon`.");
    return 1;
  }
  const { port } = JSON.parse(fs.readFileSync(infoFile, "utf8")) as { port: number };
  const token = keychainSecrets().get("daemon-token");
  if (!token) {
    console.error("No install token in the keychain. Start the daemon once with `rocky daemon`.");
    return 1;
  }
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/v1/auth/codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) {
    console.error(`Could not reach the daemon at ${base}. Is it running?`);
    return 1;
  }
  const { code } = (await res.json()) as { code: string };
  console.log(
    `Open this link within 60 seconds (single use):\n${base}/auth/bootstrap?code=${code}`,
  );
  return 0;
}

/** The running daemon's base URL and token, or null if it is not running. */
async function daemonClient(dir: string): Promise<{ base: string; token: string } | null> {
  const { daemonInfoFile } = await import("@rocky/daemon");
  const file = daemonInfoFile(dir);
  if (!fs.existsSync(file)) return null;
  const { port } = JSON.parse(fs.readFileSync(file, "utf8")) as { port: number };
  const token = keychainSecrets().get("daemon-token");
  const base = `http://127.0.0.1:${port}`;
  const up = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1500) }).catch(
    () => null,
  );
  return up?.ok && token ? { base, token } : null;
}

export async function watchCommand(
  action: "add" | "list" | "remove",
  target: string | undefined,
  opts: { dataDir?: string | undefined; recursive?: boolean },
) {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const client = await daemonClient(dir);
  if (client) {
    const headers = { authorization: `Bearer ${client.token}`, "content-type": "application/json" };
    const url = `${client.base}/api/v1/watched-folders`;
    const res =
      action === "add"
        ? await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              path: path.resolve(target ?? "."),
              recursive: opts.recursive !== false,
            }),
          })
        : action === "remove"
          ? await fetch(`${url}/${encodeURIComponent(path.resolve(target ?? ""))}`, {
              method: "DELETE",
              headers,
            })
          : await fetch(url, { headers });
    const body = (await res.json()) as {
      error?: string;
      folders?: WatchedFolder[];
      folder?: WatchedFolder;
    };
    if (!res.ok) {
      console.error(body.error ?? `daemon returned ${res.status}`);
      return 1;
    }
    printWatch(action, body.folders ?? (body.folder ? [body.folder] : []), true);
    return 0;
  }

  const rt = await openRuntime({ dataDir: dir });
  try {
    if (action === "add") {
      const f = addWatchedFolder(rt.db, target ?? ".", { recursive: opts.recursive !== false });
      printWatch(action, [f], false);
    } else if (action === "remove") {
      if (!removeWatchedFolder(rt.db, target ?? "")) {
        console.error(`Not a watched folder: ${target}`);
        return 1;
      }
      printWatch(action, [], false);
    } else printWatch(action, listWatchedFolders(rt.db), false);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rt.close();
  }
}

function printWatch(action: string, folders: WatchedFolder[], live: boolean) {
  if (action === "remove") {
    console.log("Stopped watching. Documents already imported stay until you delete them.");
    return;
  }
  if (action === "list" && folders.length === 0) {
    console.log("No watched folders. Add one with `rocky watch add <folder>`.");
    return;
  }
  for (const f of folders)
    console.log(
      `${f.path}${f.recursive ? "" : " (top level only)"}${f.enabled ? "" : " (paused)"}`,
    );
  if (action === "add")
    console.log(
      live
        ? "Watching now. New and changed files are imported automatically."
        : "Saved. The daemon imports it when it starts (`rocky daemon`).",
    );
}

export async function auditVerifyCommand(opts: { dataDir?: string | undefined; json?: boolean }) {
  const { dir } = resolveDataDir({ flag: opts.dataDir });
  const file = dataPaths(dir).db;
  if (!fs.existsSync(file)) {
    console.error(`No database at ${file}.`);
    return 1;
  }
  const db = openDb(file, { readonly: true });
  try {
    const r = verifyAuditChain(db);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.ok) console.log(`Audit log intact: ${r.checked} entries verified.`);
    else
      console.log(
        `Audit log BROKEN at entry ${r.firstBrokenSeq}: ${r.reason}. ${r.checked} entries before it verified.`,
      );
    return r.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

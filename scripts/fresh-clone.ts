// Fresh-clone check (PLAN Phase 9, acceptance #1): in a clean clone after `pnpm install`, a new
// data dir reaches a cited Ask answer through the real CLI, real SQLite store and real ingest,
// with the fake Ollama standing in for models. Run from the repo root: node scripts/fresh-clone.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOllama } from "./ci/fake-ollama.ts";

const root = process.cwd();
const cli = path.join(root, "apps", "cli", "src", "index.ts");
const corpus = path.join(root, "evals", "public", "corpus");

// Async on purpose: the fake Ollama runs in this process and must keep answering meanwhile.
function rocky(dataDir: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "--data-dir", dataDir, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => p.kill(), 10 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

function fail(msg: string): never {
  console.error(`FRESH-CLONE FAILED: ${msg}`);
  process.exit(1);
}

const fake = await startFakeOllama();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocky-fresh-"));
try {
  fs.writeFileSync(
    path.join(dataDir, "rocky.yaml"),
    `localOnly: true\nollama:\n  baseUrl: ${fake.url}\n`,
  );

  const doctor = await rocky(dataDir, ["doctor", "--json"]);
  console.log(`doctor exit ${doctor.code} (informational: CI has no whisper or real Ollama)`);

  const ingest = await rocky(dataDir, ["ingest", corpus]);
  console.log(ingest.out.trim());
  if (ingest.code !== 0) fail(`ingest exited ${ingest.code}`);

  const question = "What do economists mean by demand?";
  const ask = await rocky(dataDir, ["ask", "--json", question]);
  if (ask.code !== 0) fail(`ask exited ${ask.code}`);
  const result = JSON.parse(ask.out) as {
    notFound: boolean;
    answer: { text: string; status: string; citations: { title: string; quote: string }[] }[];
  };
  if (result.notFound) fail("the answer was 'Not found in your sources'");
  const cited = result.answer.flatMap((s) => s.citations);
  if (cited.length === 0) fail("the answer has no citations");

  // The pipeline's own quote check and verifier ran; only verified sentences may remain.
  const bad = result.answer.filter((x) => x.status !== "supported" && x.status !== "partial");
  if (bad.length) fail(`unverified sentences in the answer: ${bad.map((x) => x.text).join(" | ")}`);

  console.log(
    `OK: cited answer with ${cited.length} citation(s), first from "${cited[0]?.title}": "${cited[0]?.quote}"`,
  );
} finally {
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

#!/usr/bin/env node
import { Command } from "commander";
import { askCommand, daemonCommand, evalCommand, ingestCommand, openCommand } from "./commands.ts";
import { doctorCommand } from "./doctor.ts";

const program = new Command()
  .name("rocky")
  .description("Local-first AI assistant with verified, cited answers.")
  .option("--data-dir <path>", "data directory (overrides ROCKY_DATA_DIR)");

program
  .command("doctor")
  .description("check this machine: OS, RAM, GPU, Ollama, whisper, sqlite-vec, disk, keychain")
  .option("--json", "print the report as JSON")
  .option("--fix", "download the pinned whisper-cli build and model into the data dir")
  .action(async (opts: { json?: boolean; fix?: boolean }) => {
    const { dataDir } = program.opts<{ dataDir?: string }>();
    process.exitCode = await doctorCommand({ ...opts, dataDir });
  });

const dataDir = () => program.opts<{ dataDir?: string }>().dataDir;

program
  .command("ingest")
  .description("import a file or folder into memory and embed it")
  .argument("<path>", "file or folder")
  .action(async (target: string) => {
    process.exitCode = await ingestCommand(target, { dataDir: dataDir() });
  });

program
  .command("ask")
  .description("ask a question; answers cite your sources or say not found")
  .argument("<question...>", "the question")
  .option("--local-only", "keep every model call on this machine")
  .option("--show-flagged", "also show sentences that failed verification")
  .option("--json", "print the full result as JSON")
  .action(
    async (
      words: string[],
      opts: { localOnly?: boolean; showFlagged?: boolean; json?: boolean },
    ) => {
      process.exitCode = await askCommand(words.join(" "), { ...opts, dataDir: dataDir() });
    },
  );

program
  .command("eval")
  .description("run an eval set (evals/<set>) and check the Phase 1 gates")
  .option("--set <name>", "eval set: public or private", "public")
  .option("--local-only", "run every model call locally")
  .option("--fresh", "rebuild the eval database from the corpus")
  .option("--limit <n>", "only run the first n questions")
  .option("--json", "print the full report as JSON")
  .action(
    async (opts: {
      set: string;
      localOnly?: boolean;
      fresh?: boolean;
      limit?: string;
      json?: boolean;
    }) => {
      process.exitCode = await evalCommand({ ...opts, dataDir: dataDir() });
    },
  );

program
  .command("daemon")
  .description("run the local daemon (API, background jobs, web UI) on 127.0.0.1")
  .option("--port <n>", "port (default from rocky.yaml, 7337)")
  .action(async (opts: { port?: string }) => {
    process.exitCode = await daemonCommand({ ...opts, dataDir: dataDir() });
  });

program
  .command("open")
  .description("print a one-time sign-in link for the web UI")
  .action(async () => {
    process.exitCode = await openCommand({ dataDir: dataDir() });
  });

await program.parseAsync();

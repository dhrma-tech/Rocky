#!/usr/bin/env node
import { Command } from "commander";
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

await program.parseAsync();

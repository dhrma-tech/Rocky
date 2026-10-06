#!/usr/bin/env node
import { Command } from "commander";
import { daemonBackground, daemonInstallCommand } from "./autostart.ts";
import {
  askCommand,
  auditVerifyCommand,
  daemonCommand,
  evalCommand,
  importCommand,
  ingestCommand,
  openCommand,
  secretsCommand,
  watchCommand,
} from "./commands.ts";
import { connectorsCommand } from "./connectors.ts";
import { doctorCommand } from "./doctor.ts";

const program = new Command()
  .name("rocky")
  .description("Local-first AI assistant with verified, cited answers.")
  .option("--data-dir <path>", "data directory (overrides ROCKY_DATA_DIR)");

program
  .command("doctor")
  .description(
    "check this machine: OS, RAM, GPU, Ollama, whisper, ffmpeg, sqlite-vec, disk, keychain",
  )
  .option("--json", "print the report as JSON")
  .option("--fix", "download the pinned whisper-cli, model and ffmpeg into the data dir")
  .option("--bench", "measure transcription speed on this CPU")
  .action(async (opts: { json?: boolean; fix?: boolean; bench?: boolean }) => {
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
  .command("import")
  .description("import an audio or video recording (lecture or meeting): transcribe and extract")
  .argument("<file>", "mp3, m4a, wav, mp4, … (anything ffmpeg reads)")
  .option("--kind <kind>", "lecture or meeting", "lecture")
  .option("--title <title>", "title (default: the file name)")
  .option("--no-wait", "only queue it; the running daemon does the work")
  .action(async (file: string, opts: { kind: string; title?: string; wait: boolean }) => {
    process.exitCode = await importCommand(file, { ...opts, dataDir: dataDir() });
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
  .description(
    "run the local daemon (API, background jobs, connectors, web UI) on 127.0.0.1; 'install' starts it at sign-in",
  )
  .argument("[action]", "install | uninstall (Windows autostart)")
  .option("--port <n>", "port (default from rocky.yaml, 7337)")
  .option(
    "--background",
    "start detached with no console window, logging to <data>/logs/daemon.log",
  )
  .action(async (action: string | undefined, opts: { port?: string; background?: boolean }) => {
    if (action === "install" || action === "uninstall")
      process.exitCode = await daemonInstallCommand({
        dataDir: dataDir(),
        uninstall: action === "uninstall",
      });
    else if (action) {
      console.error(
        `Unknown action "${action}". Use: rocky daemon [install|uninstall] [--background]`,
      );
      process.exitCode = 1;
    } else if (opts.background)
      process.exitCode = await daemonBackground({ ...opts, dataDir: dataDir() });
    else process.exitCode = await daemonCommand({ ...opts, dataDir: dataDir() });
  });

program
  .command("connectors")
  .description(
    "set up and sync connectors: list, catalog, add, secret, google-client, connect, test, sync, remove",
  )
  .argument(
    "<action>",
    "list | catalog | add | secret | google-client | connect | test | sync | remove",
  )
  .argument("[args...]", "kind or id, then a secret name or file")
  .option("--repos <list>", "GitHub repositories, comma-separated owner/name")
  .option("--config <json>", "connector settings as JSON")
  .option("--purge", "with remove: also delete everything it synced")
  .option("--json", "with list: print JSON")
  .action(
    async (
      action: string,
      args: string[],
      opts: { repos?: string; config?: string; purge?: boolean; json?: boolean },
    ) => {
      process.exitCode = await connectorsCommand(action, args, { ...opts, dataDir: dataDir() });
    },
  );

program
  .command("open")
  .description("print a one-time sign-in link for the web UI")
  .action(async () => {
    process.exitCode = await openCommand({ dataDir: dataDir() });
  });

program
  .command("audit")
  .description("audit log tools")
  .command("verify")
  .description("recompute the audit hash chain and report the first broken entry")
  .option("--json", "print the result as JSON")
  .action(async (opts: { json?: boolean }) => {
    process.exitCode = await auditVerifyCommand({ ...opts, dataDir: dataDir() });
  });

const secretsCmd = program
  .command("secrets")
  .description("API keys in the OS keychain (never shown, never in files)");
secretsCmd
  .command("set")
  .argument("<name>", "anthropic, google or openai_compatible")
  .description("store a key (typed hidden, or piped on stdin)")
  .action(async (name: string) => {
    process.exitCode = await secretsCommand("set", name);
  });
secretsCmd.command("list").action(async () => {
  process.exitCode = await secretsCommand("list", undefined);
});
secretsCmd
  .command("delete")
  .argument("<name>")
  .action(async (name: string) => {
    process.exitCode = await secretsCommand("delete", name);
  });

const watchCmd = program
  .command("watch")
  .description("folders whose files are imported automatically");
watchCmd
  .command("add")
  .argument("<folder>", "folder to watch")
  .option("--no-recursive", "only the top level, not subfolders")
  .action(async (folder: string, opts: { recursive: boolean }) => {
    process.exitCode = await watchCommand("add", folder, { ...opts, dataDir: dataDir() });
  });
watchCmd.command("list").action(async () => {
  process.exitCode = await watchCommand("list", undefined, { dataDir: dataDir() });
});
watchCmd
  .command("remove")
  .argument("<folder>", "watched folder path or id")
  .action(async (folder: string) => {
    process.exitCode = await watchCommand("remove", folder, { dataDir: dataDir() });
  });

await program.parseAsync();

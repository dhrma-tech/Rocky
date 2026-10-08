# Rocky

A local-first, open-source memory and approval layer for your work. Rocky remembers your meetings, lectures, messages, documents and apps, answers with verified citations (or says "Not found in your sources"), drafts changes, and waits for your approval before anything is written. It is aimed at students and developers who are comfortable in a terminal; there is no installer yet.

> Status: V1 complete, early software ([docs/PLAN.md](docs/PLAN.md)). Verified Ask over local files, 12 connectors (all experimental, see below) and imported chat exports; meeting and lecture capture with extracted commitments; notebooks and study; routines and briefs; the approval queue and audit log; opt-in store encryption; and an MCP server, all from the CLI and a local web UI. Website: see [apps/landing](apps/landing). How it compares with hosted agents, in checkable facts: [docs/ROCKY-VS-CLOUD-AGENTS.md](docs/ROCKY-VS-CLOUD-AGENTS.md).

## Quickstart (developers)

These steps take a new Windows machine to a cited answer. macOS and Linux work the same way; only the whisper and ffmpeg downloads from `doctor --fix` are Windows-only (install them yourself elsewhere).

**1. Install the prerequisites** (once):
- [Git](https://git-scm.com/download/win).
- [Node.js](https://nodejs.org) 22.18 or newer (24 LTS recommended). Check with `node -v`.
- pnpm 10: `npm install -g pnpm@10`.
- [Ollama](https://ollama.com/download). Then, in a new terminal:
  ```sh
  ollama pull nomic-embed-text   # embeddings (~270 MB)
  ollama pull qwen3.5:4b         # the local answer model (a few GB); skip if you will only use an API key
  ```
  Little space on C:? Set the user environment variable `OLLAMA_MODELS` to a folder on another drive and restart Ollama before pulling.

**2. Get Rocky and check the machine:**

```sh
git clone https://github.com/dhrma-tech/Rocky
cd Rocky
pnpm i
pnpm rocky doctor --fix    # downloads pinned whisper-cli, its model and ffmpeg (Windows x64); creates the 16k-context local model
pnpm rocky doctor          # every line should say pass or warn; each failure prints its fix
```

Rocky keeps its data in `%APPDATA%Rocky`. To use another drive, pass `--data-dir E:RockyData` to every command or set the `ROCKY_DATA_DIR` environment variable.

**3. Ask your first question:**

```sh
pnpm rocky ingest evals/public/corpus                      # a small sample corpus that ships with the repo
pnpm rocky ask --local-only "What do economists mean by demand?"
```

The answer cites its sources, and each citation quotes the passage it came from. If nothing supports an answer, Rocky says "Not found in your sources." On a CPU-only laptop a local answer takes a minute or two. For faster, stronger answers, store an Anthropic key (`pnpm rocky secrets set anthropic`, input hidden) and drop `--local-only`; spending is capped at $10 a month by default.

**4. Open the app:**

```sh
pnpm build:web
pnpm rocky daemon          # API and UI on http://127.0.0.1:7337 (leave it running)
pnpm rocky open            # in a second terminal: prints a one-time sign-in link
```

**Troubleshooting:**
- `pnpm` not found: open a new terminal after installing it.
- `doctor` says Ollama is unreachable: start the Ollama app; it listens on 127.0.0.1:11434.
- `ask` says the model is missing: run `ollama pull qwen3.5:4b`, then `pnpm rocky doctor --fix` again.
- An answer is "Not found": run `pnpm rocky ingest <folder>` first; Rocky only answers from what it has stored.

Development: `pnpm test`, `pnpm lint`, `pnpm typecheck`. See [CONTRIBUTING.md](CONTRIBUTING.md).

Ask over your own files:

```sh
pnpm rocky ingest ~/Notes                  # import a file or folder
pnpm rocky watch add ~/Notes               # or keep a folder in sync (needs the daemon)
pnpm rocky ask "What did we decide about pricing?"
pnpm rocky ask --local-only "…"            # never leaves this machine
pnpm rocky secrets set anthropic           # API key into the OS keychain (input hidden)
pnpm rocky audit verify                    # check the append-only audit log's hash chain
```

Meetings and lectures (web UI → Meetings, or the CLI):

```sh
pnpm rocky import lecture.mp4             # transcribe locally, then extract summary, commitments, decisions
pnpm rocky import call.m4a --kind meeting --no-wait   # leave the work to the running daemon
```

The browser recorder (Chrome or Edge) captures your microphone and a shared tab or the whole screen as two channels, labelled "You" and "Others". Known limitations: no diarization beyond You/Others; system audio needs "Share system audio" (entire screen) or "Share tab audio"; on macOS and Linux system audio support varies (tab audio works); no live captions. Recording laws differ by place; the consent prompt is a reminder, not legal compliance.

Connectors (web UI → Connectors, or the CLI; setup steps in [docs/SETUP-CHECKLIST.md](docs/SETUP-CHECKLIST.md)). Each has an honest support tier: **supported** means it passes a nightly live test against a real account; **experimental** means it is tested only against recorded fixtures; **link-only** means it has no data access of its own.

| Tier | Connectors |
|---|---|
| Supported | None yet |
| Experimental | Gmail, Google Calendar, Google Drive, GitHub, Notion, Slack, Linear, Todoist, Asana, Apple Calendar (CalDAV), PostHog |
| Link-only | Notion Calendar |

The nightly live tests (`.github/workflows/live-connectors.yml`) need dedicated test accounts; Gmail, Google Calendar, Google Drive, GitHub and Notion are first in line for **supported**.

Connector code and tokens run in a separate connector host process, and each connector can reach only the hosts it declares ([docs/SECURITY.md](docs/SECURITY.md)).

```sh
pnpm rocky connectors add github --repos owner/name
pnpm rocky connectors secret github token        # fine-grained PAT, input hidden, kept in the keychain
pnpm rocky connectors add notion && pnpm rocky connectors secret notion token
pnpm rocky connectors google-client client_secret.json && pnpm rocky connectors add gmail
pnpm rocky connectors connect gmail              # Google sign-in in the browser (shared by Calendar and Drive)
pnpm rocky connectors sync                       # or let the daemon sync every few minutes
pnpm rocky daemon install                        # start the daemon at Windows sign-in (no admin needed)
```

Actions that write to your apps wait in an approval queue (web UI → Actions, or `rocky actions`). Nothing runs until you approve the exact payload shown, and every step is in the audit log.

```sh
pnpm rocky actions list --status draft
pnpm rocky actions approve <id>            # shows the payload and its hash, then asks; --yes for scripts
pnpm rocky actions run <id>
```

Chat exports (web UI → Connectors → Import an export, or the CLI). Media inside an export is skipped:

```sh
pnpm rocky import "WhatsApp Chat - Sam.zip"      # also: Discord package, Instagram JSON, X archive, LinkedIn CSVs
```

Use your memory from Claude Code (or any MCP client). The tools are read-only and every result is wrapped as untrusted data:

```sh
claude mcp add rocky -- node E:/CODEBASE/Rocky/apps/cli/src/index.ts mcp
# then ask Claude Code: "search my Rocky memory for what we decided about pricing"
```

Tools: `search_memory`, `search_notebook`, `get_document`, `list_commitments`, `list_decisions`, `list_notebooks`. Local-only documents and notebooks are hidden, and in local-only mode every tool refuses (`mcp.allowLocalOnly: true` in `rocky.yaml` overrides both). The daemon also serves the same tools over Streamable HTTP at `/api/v1/mcp` with the install token (`rocky mcp --http`).

More CLI: `rocky sync`, `rocky study [notebook] [--quiz]`, `rocky record --consent` (microphone; tab audio needs the web UI), `rocky templates list | eject <pack>`, `rocky routines`, `rocky brief`.

Web UI:

```sh
pnpm build:web
pnpm rocky daemon                          # API and UI on http://127.0.0.1:7337
pnpm rocky open                            # prints a one-time sign-in link
```

`pnpm dev` runs the daemon and the Vite dev server (http://127.0.0.1:5173) in watch mode.

Evals: `pnpm rocky eval --set public [--local-only]` runs the 30-question public set and checks the Phase 1 gates.

Data lives in `%APPDATA%\Rocky` by default. Override it with `ROCKY_DATA_DIR` or `--data-dir`.

- **Local-first:** your data stays on your machine. Local models where possible, your own API keys where they help. Local-only mode blocks every outbound model call.
- **One memory, many views:** course and project notebooks are scopes over one store, so cross-notebook questions work.
- **Trustworthy answers:** every claim is cited and checked against its source. "Not found in your sources" is a valid answer.
- **Safe actions:** every write to your apps goes through an approval queue and an append-only audit log. Email is never sent automatically.
- **Open:** memory is exposed over MCP for other AI tools.

> **Upcoming: STEVE integration.** Connect the assistant's memory to STEVE's AI departments so founders and admins get a cited company memory that agents can act on. Planned for V2.

License: [Apache-2.0](LICENSE).

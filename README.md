# Rocky

A local-first, open-source, always-on AI assistant that remembers your work (meetings, lectures, messages, documents and apps) and answers with verified citations. It acts only after you approve.

> Status: early development (Phase 8 of [docs/PLAN.md](docs/PLAN.md)). Verified Ask over local files, 12 connected apps and imported chat exports; meeting and lecture capture with extracted commitments; notebooks and study; routines and briefs; the approval queue and audit log; and an MCP server, all from the CLI and a local web UI.

## Quickstart (developers)

Requires Node 22.18+, pnpm 10, and [Ollama](https://ollama.com) with `nomic-embed-text` for embeddings. Answers use Claude when an Anthropic key is stored, and local models otherwise (or always, in local-only mode).

```sh
pnpm i
pnpm test
pnpm rocky doctor          # checks RAM, GPU, Ollama, whisper, ffmpeg, sqlite-vec, disk, keychain
pnpm rocky doctor --fix    # pinned whisper-cli + model and ffmpeg (Windows x64); creates the 16k-context local model
pnpm rocky doctor --bench  # measures transcription speed on this CPU
```

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

Connectors (web UI → Connectors, or the CLI; setup steps in [docs/SETUP-CHECKLIST.md](docs/SETUP-CHECKLIST.md)):

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

# Rocky

A local-first, open-source, always-on AI assistant that remembers your work (meetings, lectures, messages, documents and apps) and answers with verified citations. It acts only after you approve.

> Status: early development (Phase 0 of [docs/PLAN.md](docs/PLAN.md)). Nothing user-facing yet.

## Quickstart (developers)

Requires Node 22.18+, pnpm 10, and optionally [Ollama](https://ollama.com) for local models.

```sh
pnpm i
pnpm test
pnpm rocky doctor        # checks RAM, GPU, Ollama, sqlite-vec, disk, keychain
pnpm rocky doctor --fix  # downloads the pinned whisper-cli build and model (Windows x64)
```

Data lives in `%APPDATA%\Rocky` by default. Override it with `ROCKY_DATA_DIR` or `--data-dir`.

- **Local-first:** your data stays on your machine. Local models where possible, your own API keys where they help. Local-only mode blocks every outbound model call.
- **One memory, many views:** course and project notebooks are scopes over one store, so cross-notebook questions work.
- **Trustworthy answers:** every claim is cited and checked against its source. "Not found in your sources" is a valid answer.
- **Safe actions:** every write to your apps goes through an approval queue and an append-only audit log. Email is never sent automatically.
- **Open:** memory is exposed over MCP for other AI tools.

> **Upcoming: STEVE integration.** Connect the assistant's memory to STEVE's AI departments so founders and admins get a cited company memory that agents can act on. Planned for V2.

License: [Apache-2.0](LICENSE).

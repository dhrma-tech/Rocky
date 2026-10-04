# Architecture

## Process model

```
 Browser UI (Vite/React) ──HTTP+SSE──┐
 CLI (rocky) ────────────HTTP────────┤
 MCP clients ──stdio / local HTTP────┤
                                      ▼
                     ┌──────────────────────────── daemon (Node, 127.0.0.1) ─┐
                     │ Hono API · auth token · Host/Origin checks           │
                     │ Scheduler (node-cron) → jobs table                   │
                     │ Job runner (heavy jobs serialized)                   │
                     │   ├─ sync workers (connectors via connector-sdk)     │
                     │   ├─ ingest: parse → chunk → embed → index           │
                     │   ├─ transcription (whisper-cli child process)       │
                     │   └─ understanding (extraction via router)           │
                     │ Router → ProviderGate → {Ollama | Anthropic | Gemini | OpenAI-compatible}
                     │ Actions: queue → approval → executor → audit         │
                     │ Store: SQLite (better-sqlite3) + FTS5 + sqlite-vec   │
                     └──────────────────────────────────────────────────────┘
 Secrets: OS keychain (@napi-rs/keyring). Data dir: configurable (default %APPDATA%\Rocky).
```

There is a single writer: only the daemon opens the DB read-write. CLI commands that run with the daemon stopped (`doctor`, `audit verify`, `eval`) open the DB themselves and take a lock file first.

## Layers to code

| Layer | Location |
|---|---|
| Capture | `apps/web/src/capture/*` (browser), `packages/core/src/capture` (server) |
| Ingest | `packages/core/src/ingest` (parsers, chunker, embed), `packages/connectors` |
| Memory | `packages/core/src/store`, `packages/core/src/retrieval` |
| Understanding | `packages/core/src/understanding`, `packages/core/src/entities` |
| Brain | `packages/core/src/router` |
| Action | `packages/core/src/actions`, `packages/core/src/audit`, executors in each connector |
| Interface | `apps/daemon`, `apps/web`, `apps/cli`, `packages/mcp` |
| Scheduler | `apps/daemon/src/scheduler`, `packages/core/src/jobs` |

## Module boundaries inside `core`

Enforced by Biome/ESLint import restrictions:
- `store` imports nothing internal.
- `router` imports only `store` (for usage and audit) and `security`.
- `retrieval` imports `store` and `router` (for embeddings).
- `assistant` and `notebooks` may import anything except `apps/*`.
- Nothing in `core` imports a concrete connector. Connectors are registered at runtime.

## Extension points (documented, not built in V1)

- **Reranker:** a `Reranker` interface in `retrieval`, with a no-op default.
- **Parser:** a `Parser` interface `{ mimeTypes, parse(buf) → ParsedDoc with anchors }`, so a Docling sidecar can be added later.
- **Passive screen capture:** a `CaptureSource` interface. Today it's implemented by `RecorderSource` and `MediaImportSource`; a future `ScreenTextSource` would plug in here.
- **Connector plugins:** `connector-sdk` (see [specs/connectors.md](specs/connectors.md)).

## V2 seams (STEVE)

No STEVE code exists in V1. Two seams make a later bridge cheap:

1. **Outbound MCP server over memory.** STEVE's agent engine can consume `search_memory`, `list_commitments` and `list_decisions` as MCP tools with no Rocky changes.
2. **Scoped workspaces.** The `Scope` type that defines notebooks is general (source filters, tags, date range, explicit docs). A "company workspace" for STEVE departments would be a scope, exposed through the same MCP notebook-scoped tools.

Writes from STEVE would go through the existing approval queue as a new `origin` value. That is deliberately not designed in V1.

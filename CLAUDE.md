# CLAUDE.md — Rocky

Local-first, open-source, always-on AI assistant. One daemon, one SQLite memory, five modules (Capture, Memory, Assistant, Notebooks, Actions). The plan is in `docs/PLAN.md`; specs are in `docs/specs/`. All UI work (`apps/web`, `apps/landing`) follows `docs/Rocky UI UX Specification.md`: semantic tokens only, no colors outside its palette (`docs/DESIGN.md` is history). Product and backend work follows `docs/Rocky Improvement Roadmap.md`. Plan, decisions and progress: `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`.

## Communication rules (every reply)

- Short, precise, direct, honest. No flattery, filler, or restating the request.
- If something is infeasible, risky or a bad idea, say so and propose an alternative.
- Verify current docs before using any external API, library or model ID. Never invent API details.
- Phase reports: what shipped, what was tested, what's left, what you're unsure about (a few lines).

## Working agreements

- Plan mode before each phase. Small commits. Tests ship with each feature.
- Never commit secrets. User tokens live in the OS keychain only (`@napi-rs/keyring`), never `.env`, the DB or logs.
- Ask before adding a dependency that is large, unmaintained, or restrictively licensed (GPL/AGPL/SSPL/unknown).
- If a requirement is wrong, contradictory or infeasible: stop and say so.
- No STEVE-specific code in V1.

## Non-negotiables (never weaken, never skip their tests)

1. Every external write goes through `ActionService` (approval bound to the payload hash). No email is ever sent: Gmail drafts only.
2. The audit log is append-only and hash-chained.
3. All network model calls go through `ProviderGate`, which enforces local-only and the budget cap.
4. Answers are verified: deterministic quote check + verifier pass. "Not found in your sources" is valid.
5. Retrieved content is untrusted data: wrapped, tool-free, never a source of tool calls.

## Layout

```
apps/daemon apps/web apps/cli apps/landing
packages/core packages/contracts packages/connector-sdk packages/connectors packages/mcp packages/importers
templates/ evals/ docs/
```

Boundaries:
- `core` never imports concrete connectors.
- Only `core/src/router/gate.ts` imports provider SDKs.
- Only `core/src/actions/service.ts` invokes executors.

## Commands

```
pnpm i                      # install (better-sqlite3 uses bundled prebuilds; no compiler needed)
pnpm test                   # vitest: unit + security + spikes projects
pnpm test:security          # security suite (must stay green)
pnpm test:spikes            # Phase 0 spikes (Ollama/whisper ones skip if not installed)
ROCKY_SPIKE_UNDERSTANDING=1 pnpm test:spikes   # + 20-transcript local extraction (~40 min; ROCKY_RECORD=1 refreshes fixtures)
pnpm lint                   # biome check (pnpm format to fix)
pnpm typecheck              # tsc --noEmit
pnpm rocky doctor [--fix]   # machine checks; --fix fetches pinned whisper-cli + model
pnpm dev                    # daemon + web in watch mode (Phase 1)
```

No build step: Node ≥ 22.18 runs `.ts` directly (type stripping). Use erasable syntax only (no enums, namespaces, parameter properties) and `.ts` extensions in relative imports. Workspace packages export `./src/index.ts`.

## Conventions

- TypeScript strict, ESM, Node ≥ 22.18. zod for every boundary (HTTP, config, LLM structured output, connector payloads).
- IDs are ULIDs. Time is ms UTC integers in the DB.
- Model IDs and prices live in `config/*.yaml`, never in code.
- Tests: Vitest. Connector tests use recorded, scrubbed fixtures. No live API calls in CI.
- This dev machine is Windows 11, 15.7 GB RAM, no CUDA, with C: nearly full. Data dir and Ollama models go on E:.

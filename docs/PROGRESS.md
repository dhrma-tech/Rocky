# Progress

| Date | Phase | Change | Verified by |
| --- | --- | --- | --- |
| 2026-10-08 | Step 1 | Inventory; `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `PROGRESS.md` created. No code changed. | n/a (docs only) |
| 2026-10-08 | P1 / I1 | Connector host process holds connector tokens (daemon keychain view refuses them); per-connector egress allowlist on the SDK client and the host's global fetch; connector `tier` field; proposals carry provenance and strict review needs an acknowledgement (API, CLI, UI); one-time codes and sign-in links masked in mail and chat; PDF and web-page injection fixtures. | `pnpm typecheck` ok; `pnpm lint` ok (331 files); `pnpm test` 82 files, 579 passed, 1 skipped; `pnpm test:security` 16 files, 135 passed; `build:web`, `build:landing` ok; real host entry forked against a temp data dir (setup state in 1.3 s). |
| 2026-10-08 | P1 / M3, A2, M1 | Tier badges on connector cards and drawer; README tier table kept in sync by a test; nightly `live-connectors` workflow (health + one batch for the five candidates, skips without secrets); plain rate-limit and expired-token messages; landing and README repositioned (Install from GitHub, memory and approval layer, local default, API key optional); `docs/ROCKY-VS-CLOUD-AGENTS.md`. | `pnpm typecheck` ok; `pnpm lint` ok (333 files); `pnpm test` 83 files, 584 passed, 1 skipped; `build:web`, `build:landing` ok; `node apps/daemon/scripts/live-connectors.ts` prints five SKIP lines and exits 0. |

## Current phase

P1 (`feat/p1-trust-foundations`). Done: I1, M3, A2 (workflow; live passes need test accounts), M1. Next: typed event stream, A4 rules and grants, then the UI foundation.

## Known limits

- I1 egress guard is in-process (raw sockets bypass it) and both processes run as the same OS user (D-023, D-026).
- The strict-review UI is a checkbox on the current approval card; the M2 card replaces it later in P1.
- A2: no connector can be promoted to supported until the owner adds test-account secrets; Google test-mode refresh tokens expire after 7 days.

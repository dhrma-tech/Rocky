# Progress

| Date | Phase | Change | Verified by |
| --- | --- | --- | --- |
| 2026-10-08 | Step 1 | Inventory; `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `PROGRESS.md` created. No code changed. | n/a (docs only) |
| 2026-10-08 | P1 / I1 | Connector host process holds connector tokens (daemon keychain view refuses them); per-connector egress allowlist on the SDK client and the host's global fetch; connector `tier` field; proposals carry provenance and strict review needs an acknowledgement (API, CLI, UI); one-time codes and sign-in links masked in mail and chat; PDF and web-page injection fixtures. | `pnpm typecheck` ok; `pnpm lint` ok (331 files); `pnpm test` 82 files, 579 passed, 1 skipped; `pnpm test:security` 16 files, 135 passed; `build:web`, `build:landing` ok; real host entry forked against a temp data dir (setup state in 1.3 s). |

## Current phase

P1 (`feat/p1-trust-foundations`). Done: I1. Next: M3/A2 tiers in UI and README with the nightly live-test workflow, M1 copy, typed event stream, A4 rules.

## Known limits

- I1 egress guard is in-process (raw sockets bypass it) and both processes run as the same OS user (D-023, D-026).
- The strict-review UI is a checkbox on the current approval card; the M2 card replaces it later in P1.

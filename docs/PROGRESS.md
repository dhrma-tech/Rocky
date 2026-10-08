# Progress

| Date | Phase | Change | Verified by |
| --- | --- | --- | --- |
| 2026-10-08 | Step 1 | Inventory; `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `PROGRESS.md` created. No code changed. | n/a (docs only) |
| 2026-10-08 | P1 / I1 | Connector host process holds connector tokens (daemon keychain view refuses them); per-connector egress allowlist on the SDK client and the host's global fetch; connector `tier` field; proposals carry provenance and strict review needs an acknowledgement (API, CLI, UI); one-time codes and sign-in links masked in mail and chat; PDF and web-page injection fixtures. | `pnpm typecheck` ok; `pnpm lint` ok (331 files); `pnpm test` 82 files, 579 passed, 1 skipped; `pnpm test:security` 16 files, 135 passed; `build:web`, `build:landing` ok; real host entry forked against a temp data dir (setup state in 1.3 s). |
| 2026-10-08 | P1 / M3, A2, M1 | Tier badges on connector cards and drawer; README tier table kept in sync by a test; nightly `live-connectors` workflow (health + one batch for the five candidates, skips without secrets); plain rate-limit and expired-token messages; landing and README repositioned (Install from GitHub, memory and approval layer, local default, API key optional); `docs/ROCKY-VS-CLOUD-AGENTS.md`. | `pnpm typecheck` ok; `pnpm lint` ok (333 files); `pnpm test` 83 files, 584 passed, 1 skipped; `build:web`, `build:landing` ok; `node apps/daemon/scripts/live-connectors.ts` prints five SKIP lines and exits 0. |
| 2026-10-08 | P1 / EV | Typed event union (message, status, receipt, approval, memory, error) in `events` (migration 006, reversible; `rocky db rollback --to N`); emitted by actions, connector syncs and jobs; `GET /api/v1/events` SSE replays after `Last-Event-ID`; `/events/page`; web `subscribeEvents`. | typecheck, lint ok; `pnpm test` 85 files, 593 passed; rollback 6→5 smoke-tested on a temp data dir. |
| 2026-10-08 | P1 / A4 | Rules and grants (block/ask/allow, ask first wins, allow needs type + condition + end date ≤ 90 days, never send/delete/strict); 10 s Undo hold and daemon `ActionScheduler`; `/rules` API; `rocky rules`; action class (gcal invites with guests = send); migration 007 (reversible). | typecheck, lint ok (343 files); `pnpm test` 87 files, 607 passed, 1 skipped; `test:security` 17 files, 147 passed; builds ok; `rocky rules list/preview` smoke-tested. |
| 2026-10-08 | P1 / UI foundation | `@rocky/tokens` (spec tokens, light/dark, contrast tests); legacy alias layer; CSF story catalog (D-033); Playwright + axe in Edge; base components; one-value status system (eleven states). | 37 token tests; story run: axe clean in light and dark, 44px targets, no third-party requests. |
| 2026-10-08 | P1 / agent UI + screens | Run reducer, receipt, timeline, ledger row, task card, tool-call block, approval card (M2), rule editor; app shell; Today, Approvals, Tasks, Ledger, run page; deny note; `/events/page?tail`. | typecheck, lint ok (381 files); `pnpm test` 90 files, 653 passed, 1 skipped; `test:security` 17 files, 148 passed; `build:web` (main chunk 121.7 kB gzip), `build:landing` ok; Playwright 8 passed: 5 screens x 4 states x 360/768/1280 with axe and no sideways scroll, engine-down, keyboard-only pass, all stories. |

## P1 report

Done: I1 (connector host, egress allowlist, strict review, one-time-secret stripping, PDF/web fixtures), M3 tiers, A2 nightly workflow, M1/X2/X3 copy and comparison page, typed event stream with replay, A4 rules and grants with the 10 s Undo hold, design tokens, story catalog and UI test harness, base and agent components, shell, Today, Approvals, Tasks, Ledger, run page.

Not done in P1: the remaining base components (listed in the plan), the command palette, the mobile tab bar (P3), a written screen-reader pass (only axe and a keyboard pass ran), live connector passes (need test accounts).

Deviations: Ladle replaced by a CSF catalog (D-033, flagged); Projects, Memory, Files, Help, Notifications not in the nav until built (D-037); no Pause/Stop on runs (D-038); ledger not virtualised (D-036).

Manual checks for the owner: run `pnpm dev` with the daemon; approve a draft and press Undo within 10 s; approve one from a mail thread (needs the source checkbox); make an "Always allow" rule and see the next matching proposal approved and held; deny with a note and find it in the ledger payload; stop the daemon and confirm the banner and read-only page; check dark mode; try J/K on Approvals and the Ledger.

## Current phase

P1 (`feat/p1-trust-foundations`) complete; waiting for the owner's go-ahead before P2.

## Known limits

- I1 egress guard is in-process (raw sockets bypass it) and both processes run as the same OS user (D-023, D-026).
- The strict-review UI is a checkbox on the current approval card; the M2 card replaces it later in P1.
- A2: no connector can be promoted to supported until the owner adds test-account secrets; Google test-mode refresh tokens expire after 7 days.

# Decisions

Choices made where the roadmap and the UI/UX spec are silent or conflict. Newest last.

| ID | Date | Decision | Why |
| --- | --- | --- | --- |
| D-001 | 2026-10-08 | Worker chips render only for roles the engine has (browser, files, research). No orchestration is built. | Spec "one face, many hands" vs roadmap X7. |
| D-002 | 2026-10-08 | Telegram (A3): send, spend and delete get a "Review" deep link only. In-channel approve only for low-risk actions, showing summary + hash, behind a setting that is off by default. (Owner approved.) | Roadmap A3 approve buttons vs spec "notifications say Review only"; the stricter rule wins. |
| D-003 | 2026-10-08 | Browser view (screen 9): build the snapshot viewer and the take-over bar component; live take-over stays disabled until the engine supports controlled browsing. | A11 is read-only capture with no logins or forms. |
| D-004 | 2026-10-08 | Screen 2 (unlock) is not built. The engine has no passcode or lock; auth is the install token plus a one-time bootstrap cookie. No accounts. | Spec: build only if a passcode or lock exists. |
| D-005 | 2026-10-08 | Landing CTA stays "Install from GitHub" until A1 ships, then reverts to "Download". | M1. |
| D-006 | 2026-10-08 | Identity swatch and tone slider: pebble and colour only. Nothing resembling avatars or voice. | Spec low priority vs X7. |
| D-007 | 2026-10-08 | Framework detected: React 19 + TypeScript + Vite 8. No migration needed. | Spec assumption holds. |
| D-008 | 2026-10-08 | Keep Tailwind 4, TanStack Router and React Query (already in use). Tailwind's theme maps to the spec's CSS custom properties; components use semantic tokens only. | Spec silent on styling/router; least churn. |
| D-009 | 2026-10-08 | The spec names eslint-plugin-jsx-a11y; the repo lints with Biome. Use Biome's a11y rules plus axe-core in Playwright instead of adding ESLint. | Avoid a second linter. |
| D-010 | 2026-10-08 | "Always allow actions like this" (spec 17) opens a rule editor that requires at least one payload constraint and an expiry; no blanket allow exists. | X4. |
| D-011 | 2026-10-08 | Rule-allowed actions are approved by policy: the action row records the rule id as approver, and the audit chain records the payload hash, exactly as for a click. Email remains draft-only; send/delete default to ask; ask-first wins conflicts. | A4 + non-negotiable 1. |
| D-012 | 2026-10-08 | New migrations ship with a down script, and the existing pre-migration `VACUUM INTO` backup stays mandatory. Existing migrations 001–005 are forward-only and are not rewritten. | User rule 6. |
| D-013 | 2026-10-08 | Playwright browsers go on E: (`PLAYWRIGHT_BROWSERS_PATH` under an ignored cache dir in the repo). | C: is nearly full. |
| D-014 | 2026-10-08 | Approve-then-hold: an approved action waits 10 s before execution, with Undo (revoke) and an "Approve now" skip; high-risk actions keep the second confirm step. (Owner approved.) | Today execution follows approval immediately, so there is nothing to undo after the fact. |
| D-015 | 2026-10-08 | Notifications to phones (ntfy, Telegram) are daemon-side, opt-in and off by default; the UI itself makes no third-party calls. | User rule 3; spec "no third-party calls from the UI". |
| D-016 | 2026-10-08 | `docs/Rocky UI UX Specification.md` supersedes `docs/DESIGN.md` for the app and the landing page; CLAUDE.md points at the spec. DESIGN.md stays as history. (Owner approved.) | Token names and several values differ (e.g. border-strong #C1C0C4 fails 3:1; spec #8C7F82 passes). |
| D-017 | 2026-10-08 | Spec "run" maps to existing engine units (ask, routine run, job, action); no new agent loop. Projects are a lightweight record (name, folder, rules). Files shows read-only files; "created or changed" is skipped until the engine writes files. (Owner approved.) | The engine has no general tool-using agent. |
| D-018 | 2026-10-08 | Navigation: Today, Approvals, Projects, Tasks; Library: Memory, Notebooks (with Study), Commitments (with Meetings), Files, Integrations. Footer: Notifications, Help, Settings, profile. | Owner approved; 9 items. |
| D-019 | 2026-10-08 | Ladle instead of Storybook. Playwright + axe-core added in P1. Radix, Sonner, TanStack Virtual/Table added only when a screen first needs them, version and licence checked each time. No Zustand unless React state + Query can't cope. | Owner decision. |
| D-020 | 2026-10-08 | M4 local-first routing ships in P3 as an option; the current routing default stays until A8 is measured on this machine. The API key path stays an opt-in toggle. The outbound preview is shown for every cloud call regardless. | Owner decision. |
| D-021 | 2026-10-08 | Every connector is labelled "experimental" (or "link-only") until its nightly live test passes; none is "supported" yet. The nightly workflow skips when its secrets are missing. | Owner decision; M3 honesty. |
| D-022 | 2026-10-08 | Git: one branch per phase; commit and push to that branch after each roadmap item and phase once typecheck, lint, tests and build pass. Never push failing code or to main. | Owner decision. |

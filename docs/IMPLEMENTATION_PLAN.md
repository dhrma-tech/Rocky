# Implementation plan: Roadmap + UI/UX spec

Sources: `docs/Rocky Improvement Roadmap.md` (product/backend authority), `docs/Rocky UI UX Specification.md` (frontend authority). Inventory taken 2026-10-08 at `9f40a13`. Decisions and conflict resolutions: `docs/DECISIONS.md`. Progress log: `docs/PROGRESS.md`.

Status: **exists** (meets the acceptance text), **partial** (some of it is there), **missing**, **n/a** (not built by decision). Size: S ≤ 1 day, M 2–5 days, L > 1 week. Checkboxes are ticked only after the verification in the user's rule 7 has run.

## Inventory summary

| Area | What is there | Where |
| --- | --- | --- |
| Stack | React 19, TypeScript, Vite 8, Tailwind 4, TanStack Router + Query, Lucide, self-hosted Fontsource (Inter, Instrument Serif, JetBrains Mono), React Flow, pdf.js. No Radix, cmdk, Sonner, Storybook, Playwright, axe. | `apps/web/package.json` |
| Web UI | 10 sidebar pages: Home, Ask, Notebooks, Study, Meetings, Commitments, Actions, Routines, Connectors, Settings. Light/dark via `data-theme`. Tokens follow `docs/DESIGN.md` naming, not the spec's. | `apps/web/src/{Shell.tsx,routes,components,styles}` |
| Daemon | Hono on 127.0.0.1, install token + one-time bootstrap cookie, Host/Origin checks. SSE per job (`/jobs/:id/events`) and for `/ask`. No global typed event stream, no sequence replay. | `apps/daemon/src` |
| Actions | `ActionService`: draft → approved (hash-bound) → executing → executed/failed; edit re-hashes; risk low/medium/high; injection flag on payload. No rules/policy table; every action needs a click. | `packages/core/src/actions` |
| Audit | Append-only, hash-chained; `rocky audit verify` exists. No export, no evidence pack, no anchoring. | `packages/core/src/audit`, `apps/cli` |
| Security | `wrapUntrusted` on retrieved content in all LLM prompts; instruction-pattern flagger; secrets in keychain. Connectors run **in the daemon process** with scoped secret access. No OTP/reset-link stripping, no egress proxy, no injection fixtures for PDFs/web. | `packages/core/src/security`, `packages/core/src/connectors/service.ts` |
| Store | SQLite (better-sqlite3), migrations 001–005 with `VACUUM INTO` backup before migrating (newest 3 kept). SQLCipher available but **opt-in** (`rocky db encrypt`). No daily backup. Migrations are forward-only (no down). | `packages/core/src/store` |
| Router | `ProviderGate` single gate, local-only mode, budget cap. `chat`, `draft`, `routine`, `judge` default to `api:strong` (contradicts M4/X2). | `packages/core/src/router`, `config/policies.yaml` |
| Connectors | 12: gmail, gcal, gdrive, github, notion, notion-calendar (link-only), slack, linear, todoist, asana, posthog, caldav. No status tier field. Fixture tests only. | `packages/connectors` |
| Importers | WhatsApp, Discord, Instagram, X, LinkedIn, chat, CSV, files. No ChatGPT/Claude archive importer. | `packages/importers` |
| MCP | Read-only: search_memory, search_notebook, list_notebooks, get_document, list_commitments, list_decisions. Labelled untrusted. No propose_action/get_receipt, no per-agent tokens. | `packages/mcp` |
| Routines | Cron (croner), catch-up after sleep (latest missed run), template packs. Files/YAML not user-authored. | `packages/core/src/assistant/routines.ts` |
| OS service | Windows HKCU Run key via CLI only. No launchd/systemd, no Windows service. | `apps/cli/src/autostart.ts` |
| Lock/passcode | None. Auth is the install token + bootstrap cookie. | `apps/daemon/src/auth.ts` |
| CI | Lint, typecheck, security, unit on Windows + Ubuntu; fresh-clone job. No release, CodeQL, Dependabot. | `.github/workflows/ci.yml` |
| Evals | Public set + runner; private-set runbook. | `evals/`, `packages/core/src/evals` |

## Phases

| Phase | Branch | Scope (in order) |
| --- | --- | --- |
| P1 Trust and foundations | `feat/p1-trust-foundations` | I1, M3/A2 tiers (A2 live tests need user accounts), M1 copy, typed event stream, tokens (spec), base components, Ladle + Playwright + axe harness, app shell, status system, receipt, M2 approval card + queue, A4 rules + grants, A10 ledger + run page, Today |
| P2 Installable and daily use | `feat/p2-installable-daily` | A1, I3, M5, A8, A9; Onboarding, Chat/workspace, A5 + Memory, A6 + Background, Settings + rules, Projects, Files, Profile, Help, Task creation, Task history |
| P3 Reach and proactive | `feat/p3-reach-proactive` | A3 PWA + Telegram, Notifications, mobile layout, A7, M4 + X2, A11 + browser snapshot viewer |
| P4 Differentiate and prove | `feat/p4-differentiate` | D1, D2, D3, D4, D6, D7/M6, I2, I4, I5, I6, I7; landing rebuilt from app components |

## Roadmap items

| ID | Item | Status | Paths | Phase | Depends on | Acceptance (from the roadmap) | Size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Installer + packaged release | missing | new `apps/desktop`?, `.github/workflows/release.yml` | P2 | I3, A8 | Tauri or Electron shell; macOS/Windows/Linux installers built in GitHub Actions; first run detects RAM, checks Ollama, pulls a sized model; Docker Compose fallback; Homebrew/winget/scoop manifests; unsigned-installer workaround documented | L |
| A2 | Live connector validation + tiers | partial (fixture tests only) | `packages/connectors`, `.github/workflows/nightly.yml` | P1 (tiers), P1→ (live, needs user test accounts) | M3 | Gmail, GCal, Drive, GitHub, Notion 'supported'; nightly smoke tests against test accounts held as repo secrets; the rest 'experimental' in UI and README; token-refresh failures and rate limits visible | M |
| A3 | Phone + messaging front end | missing | `apps/web` (PWA), new `packages/core/src/channels/telegram.ts` | P3 | I1, M2, A4 | Telegram bot with user-ID allowlist; PWA reachable via Tailscale/Cloudflare Tunnel; approvals show summary + hash, full payload in PWA; every channel message untrusted. **See DECISIONS D-002** | M |
| A4 | Rule-based approvals, scoped time-bound grants | missing | new `packages/core/src/actions/policy.ts`, migration 006 | P1 | — | Policy keyed by connector, action class and payload constraints → allow/ask/block; email draft-only; deletes/sends default ask; auto-allowed actions still write payload hash to audit; ask-first wins; grants expire | M |
| A5 | Editable, versioned memory profile | missing | new `packages/core/src/profile/`, data dir `profile/` (git) | P2 | A4 (proposals via queue) | Markdown files in a git repo in the data dir; each line has provenance (user-stated or named source); edits arrive as proposals through the approval queue, accepted as diffs; `rocky memory export`; never store inferences as facts | M |
| A6 | User-defined routines and skills | partial (cron routines from packs) | `packages/core/src/assistant/routines.ts` | P2 | A4 | Routine = markdown/YAML with schedule, prompt, allowed tools, approval boundary; scheduler catches up after sleep; output saved as cited note; folder-per-skill; format compatibility confirmed before claimed | M |
| A7 | Proactive heads-up engine | missing (commitments extracted) | `packages/core/src/assistant/`, jobs | P3 | D6, A3 | Nightly job scores commitments by due proximity + staleness; threshold + daily cap; desktop/Telegram notify; dismiss lowers similar scores; read-only tools by construction | M |
| A8 | Hardware-aware model setup + speed profile | partial (`tier()` by RAM/GPU in policies; doctor) | `packages/core/src/doctor.ts`, `config/policies.yaml` | P2 | I2 | Detect RAM/GPU and recommend tiers (validated against own eval); small model for retrieval/verify, larger for synthesis; stream sentence-by-sentence as each passes verification; cache embeddings/retrieval; optional free-tier cloud model behind the gate after checking limits | L |
| A9 | First-run sample workspace | partial (templates/ packs) | `templates/`, onboarding | P2 | — | Fictional meetings, mail, docs; guided tour fully offline; after first import, suggested questions from the user's data | S |
| A10 | Activity view | partial (audit list in ActionsPage) | `apps/web/src/routes/ActionsPage.tsx`, jobs | P1 | event stream | One page over audit log + job table; pause and stop; per-connector sync status | M |
| A11 | Read-only web capture | missing | new `packages/core/src/capture/web.ts` (Playwright subprocess) | P3 | I1 | Sandboxed subprocess fetches page, extracts readable text, stores snapshot + hash; no logins, no forms; content untrusted | M |
| M1 | Reposition and relabel | partial | `apps/landing`, `README.md` | P1 | — | 'Verifiable memory and approval layer'; 'Install from GitHub' until A1 ships; aimed at technical early adopters/students; 'Rocky vs cloud agents' page with documented facts only | S |
| M2 | Approval cards for humans | partial (risk, email preview, editable JSON shown by default) | `apps/web/src/routes/ActionsPage.tsx`, new `agent-ui/ApprovalCard` | P1 | tokens | Readable before/after summary, risk label, destination, expandable hash + payload; per-connector templates; JSON fallback | M |
| M3 | Honest connector count and tiers | missing | connector-sdk manifest, UI, README | P1 | — | 'supported', 'experimental', 'link-only'; status field in connector metadata surfaced in UI and README | S |
| M4 | Local-first routing + outbound preview | missing | `packages/core/src/router`, `config/policies.yaml` | P3 | I2 | Default local; escalate only on low retrieval confidence or verification pass rate; show exact passages before each cloud call; per-query toggle; sensitive-class tags | M |
| M5 | Encryption on by default | partial (opt-in SQLCipher + migrate command) | `packages/core/src/store/encryption.ts`, config defaults | P2 | — | SQLCipher default for new installs, key in keychain; migration path for existing stores | S |
| M6 | Study mode packaging | partial (Study page exists) | `apps/web/src/routes/Study*`, landing | P4 | A1 | Separate onboarding and a distinct landing section | S |
| I1 | Injection + credential isolation | partial (MCP/retrieval wrapping, flagger) | `packages/core/src/{security,connectors,ingest}`, new connector worker | P1 | — | Untrusted labelling on everything ingested (mail, chat exports, web, PDFs); write proposals show the instruction's origin and get stricter review; strip OTPs and reset links at email ingestion; connector code in a separate process holding keychain access; allowlist egress proxy around connector processes; public injection test suite in CI (PDF, email, web) | L |
| I2 | Reproducible eval | partial (public set + runner) | `evals/`, `packages/core/src/evals` | P4 | — | Citation faithfulness, 'Not found' P/R, dropped-sentence rate, latency by hardware tier; adversarial + multilingual sets; run in CI on a small model | M |
| I3 | Daemon as OS service + backups | partial (Windows Run key; pre-migration backup) | `apps/cli/src/autostart.ts`, `packages/core/src/store` | P2 | — | launchd, systemd user, Windows service units via `rocky doctor --fix`; auto-start; catch-up after sleep; daily `VACUUM INTO` backups; always-on docs | M |
| I4 | Citation experience | partial (SourceViewer, verified.tsx) | `apps/web/src/components/{verified,SourceViewer}.tsx` | P4 | — | Show dropped-sentence count and why; open exact page/timestamp with quote highlighted | S |
| I5 | Commitment precision | missing | `packages/core/src/understanding`, evals | P4 | — | Precision on labelled meetings; one-click correction feeds eval set; cite line behind each commitment | M |
| I6 | Multilingual quality | missing | evals, capture | P4 | I2 | Hindi, Marathi, code-mixed tests with multilingual whisper + BGE-M3 (verify); publish results | M |
| I7 | Release + supply-chain hygiene | partial (pinned deps) | `.github/` | P4 | A1 | Dependabot, CodeQL, pinned deps, signed release attestations, written threat model | S |
| X1 | Freeze new connectors | n/a (do not build) | — | — | — | No new connectors until core five pass nightly | — |
| X2 | Retire 'Recommended: your API key' | partial | landing, onboarding, `policies.yaml` | P3 (with M4) | M4 | Local default; key as opt-in accelerator with outbound preview | S |
| X3 | Avoid autonomy marketing | partial (copy audit) | landing, README | P1 (with M1) | — | Say: remembers, cites, drafts, waits for approval | S |
| X4 | No blanket 'always allow' | missing (enforced by A4) | A4 | P1 | A4 | Grants only with payload constraints and an expiry | S |
| X5 | Drop hero cards, curved gallery, Product dropdown | n/a (do not build); remove if present in landing | `apps/landing` | P4 | — | Time goes to real screenshots and a short demo | S |
| X6 | No hosted tier, telemetry, training | n/a (invariant) | — | — | — | No backend; no telemetry | — |
| X7 | No voice, avatars, multi-agent orchestration | n/a (do not build) | — | — | — | — | — |
| D1 | MCP trust gateway | missing (read-only MCP exists) | `packages/mcp` | P4 | A4, D2, I1 | `propose_action` and `get_receipt`; reuse approval queue + audit; per-agent tokens scoped to connectors and action classes; setup recipes; directory listings | M |
| D2 | Receipts / audit verify + export | partial (`rocky audit verify`) | `packages/core/src/audit`, CLI | P4 | — | Verify command, JSON/PDF export, optional head anchoring to a public git commit; evidence pack per action (sources, payload, approver, time, result) | M |
| D3 | Fail-closed answers as brand | partial (Not found + verifier exist) | landing, I2, I4 | P4 | I2, I4 | 'Not found' and dropped sentences visible; published faithfulness numbers; 'verified mode' callable by other tools | S |
| D4 | Memory you own and can move | partial (5 social importers) | `packages/importers` | P4 | A5 | ChatGPT and Claude archive importers (formats validated first) with A5 provenance; clean export | M |
| D5 | Sovereign, offline, multilingual | partial | — | P4 (via A8, I6) | A8, I6 | Works on 8–16 GB, offline, Indian languages, published numbers | — |
| D6 | Cited commitments ledger | partial (Commitments page) | `apps/web/src/routes/CommitmentsPage.tsx` | P4 | A7, I5 | Who owes whom what by when across sources, quoted evidence, nudges before due | M |
| D7 | Study as a wedge | partial (notebooks, quizzes, SM-2, export) | `packages/core/src/notebooks` | P4 | A1 | Notebooks, cited guides, quizzes, spaced repetition, Anki export (verify format) | S |

## Cross-cutting backend contracts

| ID | Item | Status | Paths | Phase | Acceptance (from the spec) | Size |
| --- | --- | --- | --- | --- | --- | --- |
| EV | Typed event stream | missing (per-job SSE only) | new `packages/contracts/src/events.ts`, daemon `/api/v1/events` | P1 | Union of message, status, receipt, approval, memory, error; replay missed events by sequence number; "Connection lost. Reconnecting…" replays | M |
| ST | One status value | missing | `packages/contracts/src/status.ts`, `apps/web/src/agent-ui/status.ts` | P1 | Pebble, chip, timeline icon, notification render from one value and always agree | S |
| RC | Receipt model | missing | contracts + action/job completion | P1 | Tool, verb, result, count, what did not happen; click opens the event | S |

## UI: design system

| ID | Item | Status | Paths | Phase | Acceptance (from the spec) | Size |
| --- | --- | --- | --- | --- | --- | --- |
| U-T1 | Three-tier tokens (primitive/semantic/component), light + dark, from one `tokens.json` | partial (DESIGN.md tokens, different names/values) | `apps/web/src/styles/tokens.css` → `packages/tokens` or `apps/web/src/tokens/` | P1 | Spec names and hex values exactly; `data-theme` with system default and manual override; landing and Storybook render from the same file and pass the listed contrast values | M |
| U-T2 | Status colours + identity swatches | missing | tokens | P1 | 4 statuses × text/tint/dark + icon; 6 swatches; identity never carries state | S |
| U-T3 | Type scale | partial | tokens + Tailwind theme | P1 | 10 styles, weights 400/500/600 only, 12px floor, tabular figures, chat measure 72ch, serif never in controls/tables/chat | S |
| U-T4 | Spacing, radius, shadow, borders | partial | tokens | P1 | Spec scales; soft material only on decorative objects; dark uses top border instead of shadow | S |
| U-T5 | Motion tokens + reduced motion | partial | tokens, CSS | P1 | 120/200/320/500ms; standard/exit easings; transform/opacity only; reduced-motion substitutes lose no information | S |
| U-T6 | Fonts self-hosted, Latin subset, swap | exists (subset to verify) | `apps/web/src/main.tsx` | P1 | No third-party font requests | S |
| U-L | Layout grid + breakpoints | missing | tokens, shell | P1 | xs<600, sm 600–899, md 900–1199, lg 1200–1599, xl ≥1600; 12 cols; containers 720/960/760+320/1120 | S |

## UI: components (one component per concept)

| ID | Group | Status | Phase | Acceptance | Size |
| --- | --- | --- | --- | --- | --- |
| U-C1 | Controls: Button (4 variants, 44/36), Input, Textarea, Select/listbox, Radio, Checkbox, Switch, Segmented, Tabs | partial (`components/ui.tsx`) | P1 | Spec table "Controls and inputs"; stories for default, hover, focus, disabled, loading, empty, error; keyboard pass | M |
| U-C2 | Command palette (cmdk) | missing | P2 | Ctrl/Cmd+K; groups Actions/Projects/Tasks/Settings; recent first; shortcuts shown; every command also in UI | S |
| U-C3 | Navigation/containers: Sidebar + rail, Top bar/breadcrumb, Card, Modal, Drawer/Sheet, Toast (Sonner), Alert/Banner, Tooltip | partial (sidebar, Card) | P1 | Spec table "Navigation and containers" | M |
| U-C4 | Data display: Table (TanStack), List, Avatar, Status chip, Progress, Skeleton | partial (Badge) | P1 | Spec table "Data display"; virtualised where long | M |
| U-C5 | Conversation/agent (custom, `agent-ui/`): Pebble, Status chip system, Receipt, Run card, Timeline, Activity/ledger row, Tool-call block, Worker chip, Approval card, Take-over bar, Memory notice + diff, File chip/row, Task card, Chat message, Composer | partial (approval card, composer exist in other shape) | P1 (pebble, chip, receipt, approval, ledger row, timeline, task card, tool-call), P2 (message, composer, run card, memory notice/diff, file row, worker chip), P3 (take-over bar) | Spec "Conversation and agent components" + "What to build yourself"; stories for every state in the eleven-state table; reused on landing | L |
| U-C6 | Error pattern (8 cases) + error boundary | partial | P1 | Icon, plain title, one sentence, what Rocky did, one fix, Details; never lead with a code | S |
| U-C7 | Empty pattern (10 screens) | partial | P1→P2 | Serif headline ≤6 words, one sentence, one action | S |

## UI: the eleven states

| State | Status | Phase | Acceptance |
| --- | --- | --- | --- |
| Thinking | missing | P1 | Breathing pebble 2.4s; info chip "Thinking"; after 8s elapsed + "Taking longer than usual"; Stop |
| Working | missing | P1 | Info chip "Working · step n of m"; one live verb line; finished steps collapse to receipts; Pause, Stop, Add instruction |
| Browsing | missing | P3 | Globe on chip; snapshot refresh; take-over bar (live take-over disabled, D-003) |
| Using a tool | missing | P1 | Tool-call block with tool, target, permission badge, live duration → receipt |
| Needs approval | missing | P1 | Pebble stops, blush ring; warning chip "Needs you" + hand icon; inline card + queue + notification; run visibly paused |
| Completed | missing | P1 | Rest + check; success chip "Done"; one-line summary with counts; Open results, Undo, Re-run |
| Failed | missing | P1 | Static + error mark; error chip; failed step auto-opens with what happened / tried / you can do; receipts stay |
| Waiting | missing | P2 | Dimmed; neutral chip with clock; what and until when; Check now, Stop waiting |
| Background | missing | P2 | Sidebar "n running"; neutral chip; notify only needs-you/done/failed |
| Learned | missing | P2 | Bookmark mark; "Learned" chip; batched memory notice; Edit, Forget, Accept |
| Remembers | missing | P2 | "Used memory: …" chip with book icon; hover shows line; click opens file |

Done when (spec F.5): a recorded run shows every state and the four places agree.

## UI: screens (12 fields each per spec)

| # | Screen | Status | Existing | Phase | Size |
| --- | --- | --- | --- | --- | --- |
| — | App shell | partial | `Shell.tsx` (different IA) | P1 | M |
| 1 | Landing | partial (DESIGN.md §4 version) | `apps/landing` | P4 | M |
| 2 | Sign-up / unlock | **n/a** (no passcode/lock in engine; D-004) | — | — | — |
| 3 | Onboarding | missing | — | P2 | M |
| 4 | Today | partial | `HomePage.tsx` | P1 | M |
| 5 | Chat + workspace | partial | `AskPage.tsx` | P2 | L |
| 6 | Task creation drawer | missing | — | P2 | M |
| 7 | Running task (run page) | missing | — | P1 | M |
| 8 | Ledger | partial | audit list in `ActionsPage.tsx` | P1 | M |
| 9 | Browser view | missing | — | P3 (snapshot viewer + bar; live off) | M |
| 10 | Task history | missing | — | P2 | M |
| 11 | Background | partial | `RoutinesPage.tsx` | P2 | M |
| 12 | Projects | missing (no project entity) | — | P2 | L |
| 13 | Memory | missing | — | P2 | M |
| 14 | Files | missing | — | P2 | M |
| 15 | Integrations | partial | `ConnectorsPage.tsx` | P2 (tiers in P1) | M |
| 16 | Notifications | missing | — | P3 | M |
| 17 | Approvals | partial | `ActionsPage.tsx` | P1 | M |
| 18 | Settings | partial | `SettingsPage.tsx` | P2 (rules in P1) | M |
| 19 | Profile | missing | — | P2 | S |
| 20 | Help | missing | — | P2 | M |
| 21 | Error states (system) | partial | scattered | P1 | S |
| 22 | Empty states (system) | partial | scattered | P1→P2 | S |
| 23 | Mobile | missing | — | P3 | L |
| — | Existing features outside the spec: Notebooks, Study, Meetings, Commitments | exist | `routes/*` | restyle P2, D6/D7 P4 | M |

Per-screen "Done when" (spec F.3): loading, empty, error and populated states at 360, 768, 1280px; axe clean; keyboard pass.

## Stack choices

| Need | Spec pick | Status | Phase | Note |
| --- | --- | --- | --- | --- |
| Framework | React + TS + Vite | exists | — | Detected; no migration |
| Primitives | Radix (shadcn approach) | missing | P1 | Verify version + licence (MIT) before adding |
| Icons | Lucide | exists | — | |
| Router/data | (not in spec) TanStack Router + Query | exists | — | Kept |
| Styling | (not in spec) Tailwind 4 | exists | — | Kept; theme maps to spec CSS vars (D-008) |
| Animation | CSS first; Motion only for presence | missing | P2 if needed | |
| Charts | uPlot; hand SVG health strip / meter | missing | P2 | |
| Editor | CodeMirror 6 (Markdown) | missing | P2 | Lazy |
| Markdown | react-markdown + remark-gfm + rehype-sanitize | missing | P2 | |
| Code blocks | Shiki (lazy) | missing | P2 | |
| Palette | cmdk | missing | P2 | |
| DnD | dnd-kit | missing | when needed | |
| Forms | React Hook Form + zod | missing | P2 | zod already used |
| Toasts | Sonner | missing | P1 | |
| Virtual lists/tables | TanStack Virtual + Table | missing | P1 | |
| State | Reducer over event union; Zustand for UI | missing | P1 | |
| Live updates | SSE + seq replay | partial | P1 | |
| Diffs | jsdiff | missing | P2 | |
| Tokens | CSS vars from one tokens.json | partial | P1 | |
| Component docs | Ladle (owner chose over Storybook) | missing | P1 | D-019 |
| E2E/screens/a11y | Playwright + axe-core; eslint-plugin-jsx-a11y | missing | P1 | Repo uses Biome, not ESLint: use Biome a11y rules (D-009) |
| PWA | vite-plugin-pwa | missing | P3 | |
| Phone push | ntfy | missing | P3 | Off by default |
| Browser view | Playwright screencast | missing | P3 | Snapshot only until controlled browsing exists |
| Docs site | Starlight/VitePress | missing | P4 | In-app help ships first |

## P1 checklist (ticked only after verification)

- [ ] I1a Untrusted labelling + provenance for all ingested sources; OTP/reset-link stripping at email ingestion
- [ ] I1b Connector worker process holding keychain access; daemon never reads connector tokens
- [ ] I1c Egress allowlist for the connector process
- [ ] I1d Injection fixtures (PDF, email, web) in `test:security`
- [ ] M3 Connector tier field (supported/experimental/link-only) in SDK + UI + README
- [ ] A2 Nightly live smoke workflow (skips without secrets)
- [ ] M1/X3 Copy changes in README and landing
- [ ] EV Typed event union + `/api/v1/events` with seq replay
- [ ] A4 Policy table + grants (migration 006, reversible, backup first)
- [ ] U-T1–T5, U-L Tokens from tokens.json, light + dark
- [ ] Ladle + Playwright + axe harness
- [ ] U-C1, U-C3, U-C4 base components with stories
- [ ] Agent-ui P1 set: pebble, status chip, receipt, approval card, ledger row, timeline, task card, tool-call block
- [ ] App shell with new IA
- [ ] Screen 17 Approvals, 8 Ledger, 7 Run page, 4 Today, 21 error pattern

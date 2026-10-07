# Spec: UI and daemon API contracts

- Stack: Vite + React + TanStack Router + TanStack Query + Tailwind + shadcn/ui. Visual design follows [DESIGN.md](../DESIGN.md) (tokens, components, screens). This spec fixes the **data contracts** only.
- All schemas live in `packages/contracts` (zod). Base path `/api/v1`. Streaming endpoints use SSE.
- Every response that contains model output includes `path: PathInfo` (local/API chip). Every citation is `{chunkId, documentId, title, anchor, quote}` and opens the shared **SourceViewer** via `GET /documents/:id/anchor?chunk=`.

| Screen | Phase | Endpoints |
|---|---|---|
| **Ask** (global/scoped) | 1 | `POST /ask` (SSE) · `GET /conversations` · `GET /conversations/:id` · `GET /scopes/options` (notebooks, connectors, people, date presets) |
| **SourceViewer** (shared) | 1 | `GET /documents/:id` · `GET /documents/:id/anchor?chunk=` · `GET /blobs/:hash` (PDF/audio, range requests) · `DELETE /documents/:id` |
| **Settings** | 1–2 | `GET/PUT /settings` (models, policies, data dir, local-only, budget cap) · `GET /system/hardware` · `POST /system/benchmark` · `GET /usage?month=` (spend, by task/model) · `POST /secrets/:name` (write-only; never readable) · `POST /deletion` `{target}` + typed confirmation · `GET /templates` |
| **Actions** | 2 | `GET /actions?status=` · `GET /actions/:id` · `PATCH /actions/:id` (edit payload while draft) · `POST /actions/:id/approve {payloadHash}` · `POST /actions/:id/reject` · `POST /actions/:id/execute` · `GET /audit?cursor=&type=` · `POST /audit/verify` |
| **Meetings** | 3 | `POST /recordings` (consent payload) → `{id}` · `PUT /recordings/:id/chunks/:n` (binary) · `POST /recordings/:id/stop` · `POST /imports/media` (multipart) · `GET /meetings` · `GET /meetings/:id` (segments, summary, extracted items) · `GET /jobs/:id/events` (SSE progress) |
| **Commitments & Decisions** | 3 | `GET /commitments?status=&owner=&due_before=` · `PATCH /commitments/:id` · `POST /commitments` (manual) · `GET /decisions?q=&owner=` · `GET /entities?q=` · `POST /entities/:id/merge` |
| **Connectors** | 4 | `GET /connectors` (with health and last sync) · `GET /connectors/catalog` (built-in + plugins, config schema as JSON Schema) · `POST /connectors` `{kind, config}` · `POST /connectors/:id/auth` (starts OAuth, returns URL) · `POST /connectors/:id/test` · `POST /connectors/:id/sync` · `GET /connectors/:id/log` · `DELETE /connectors/:id?purge=` · `POST /imports/archive?filename=` (streamed upload) · `POST /imports/archive/path` `{path, format?}` (CLI) · `GET /imports/archives` · `DELETE /imports/archives/:format?archive=` (Phase 8, Import panel) |
| **Notebooks** | 5 | `GET/POST /notebooks` · `GET/PATCH/DELETE /notebooks/:id` · `GET /notebooks/:id/sources` · `POST/DELETE /notebooks/:id/sources/:docId` · `POST /notebooks/:id/scope/preview` (rule → matching docs count) · `GET /notebooks/:id/workload` · `POST /notebooks/:id/guide` (SSE) · `POST /notebooks/:id/mindmap` · `GET /notebooks/:id/export?format=anki\|md` · `POST /notebooks/:id/source-pack` (→ action proposal) |
| **Study** | 5 | `GET /study/review?notebook=` · `POST /cards/:id/review {rating}` · `POST /notebooks/:id/cards/generate` · `PATCH/DELETE /cards/:id` · `POST /quizzes` `{notebookId, topics, difficulty, examGrade}` · `GET /quizzes/:id/next` · `POST /quizzes/:id/answer` · `GET /notebooks/:id/countdown` (exam, weak topics, daily plan) |
| **Home & Brief** | 6 | `GET /home` (today timeline, due/overdue commitments, pending approvals count, last routine run) · `GET /timeline?from=&to=` · `POST /briefs` `{eventId \| notebookId}` (SSE; facts are computed, sentences verified) · `GET /briefs/latest?kind=&subject=` |
| **Routines** | 6 | `GET/POST /routines` · `POST /routines/from-template` `{pack, template?}` · `GET/PATCH/DELETE /routines/:id` · `POST /routines/:id/run` (→ job) · `GET /routines/:id/runs` · `GET /templates` |
| **Drafts** (in Actions) | 6 | `POST /drafts` `{threadId?, instruction, channel}` (SSE) → `gmail.draftCreate` proposal · `GET /style` · `POST /style/refresh` (→ job) · `POST /proposals` `{documentId, instruction}` (≤ 10 cited proposals) |

## Global UI rules

- Recording indicator in the app shell whenever `GET /recordings/active` is non-empty (polled every 5 s, or via SSE `/events`).
- Egress indicator on every model-backed view. A local-only badge when on.
- Model output is rendered with a safe markdown renderer: no raw HTML, no remote images, links shown as text plus an explicit open button.
- Errors are shown verbatim with the job or connector ID. `BudgetExceeded` and `EgressBlocked` get dedicated messages explaining the reason and how to change it.

## Auth bootstrap

`rocky open` → the daemon issues a one-time code → `GET /auth/bootstrap?code=` sets the HttpOnly session cookie and redirects to `/`.

# Connectors — verified findings

Checked 2026-10-02; GitHub, Notion, Gmail, Calendar and Drive re-verified 2026-10-06 for Phase 4, the other seven on 2026-10-07 for Phase 7 (see the re-verification sections below). Setup steps per connector: [CONNECTORS-SETUP.md](CONNECTORS-SETUP.md). **Re-verify each connector's docs at the start of the phase that implements it** and update this file. Items marked (re-verify) are ones where sources disagreed or I could not confirm them.

General rules:
- Read-sync first.
- Writes only via the approval queue.
- No webhooks in V1, because they need a public URL. Polling on a schedule, plus Socket Mode for Slack.
- Idempotent upsert on `(connector_id, external_id)` + `content_hash`.
- Backoff: exponential with jitter, honoring `Retry-After`, with a max of 5 attempts before the error goes to `connector_state.last_error`.

| # | Connector | Auth | Incremental strategy | Writes | Key facts / limits |
|---|---|---|---|---|---|
| 1 | Gmail | Google OAuth, desktop client, loopback redirect + PKCE, user's own GCP project | `history.list` from stored `historyId`; initial backfill `messages.list q=newer_than:90d` (configurable) | `drafts.create` / `drafts.update` only | Scopes: `gmail.readonly` + `gmail.compose`, both **restricted**. `gmail.compose` technically allows send, so "never send" is enforced in code with a CI check. Testing-mode apps get **7-day refresh tokens**, so publish "In production" unverified for personal use. Max 50 refresh tokens per client+user. |
| 2 | Google Calendar | Same OAuth | `events.list` with `syncToken`; handle 410 → full resync | `events.insert` / `events.patch` | Scopes `calendar.events` + `calendar.readonly` (sensitive). Exam detection: events whose title or description matches the notebook's exam tag. |
| 3 | Google Drive | Same OAuth | `changes.list` with `pageToken` (`changes.getStartPageToken` first) | Upload into the designated source-pack folder only | Read needs `drive.readonly` (restricted); writes use `drive.file` (only app-created files). Docs export as `text/markdown` or `text/plain` (re-verify markdown export support); Slides as text; PDFs downloaded and parsed locally. |
| 4 | Notion | Internal integration token; user shares pages with the integration | `search` sorted by `last_edited_time`, cursor = max seen; recurse `blocks.children` | Pages and data-source rows: create/update | Pin `Notion-Version: 2026-03-11` (latest). Since 2025-09-03, databases contain **data sources**: query via `/v1/data_sources/:id/query`. 2026-03-11 replaced `archived` with `in_trash`. Rate limit ~3 req/s average (re-verify). Official Notion MCP exists, but use the REST API for sync (deterministic cursors). |
| 5 | GitHub | Fine-grained PAT (repo-scoped) | Issues/PRs `?since=&sort=updated`; commits `?since=` per repo; review comments per PR | Create issue, comment | 5,000 req/h. PAT permissions: Metadata R, Contents R, Issues RW, Pull requests R. Max PAT expiry 366 days, so `health()` warns 14 days before. |
| 6 | Linear | Personal API key (header `Authorization: <key>`) | GraphQL `issues(filter:{updatedAt:{gt:cursor}})` with pagination | `issueCreate`, `issueUpdate` | ~2,500 req/h and 250k complexity points/h for API keys (re-verify); rate headers on each response. Keep `first` small to limit complexity. |
| 7 | Todoist | API token | **Unified API v1** `/api/v1/sync` with `sync_token` | Create task, close task | REST v2 shut down 2026-02-10 (returns 410). IDs are opaque strings now. |
| 8 | Slack | Internal app in own workspace; **Socket Mode** (`xapp-` app token with `connections:write`) + bot token `xoxb-` | Live: events over Socket Mode (`message.channels`, `message.groups`). Backfill: `conversations.history` per joined channel, bounded (default 30 days) | None against Slack; drafts stay local (copy + deep link) | Bot scopes: `channels:history, groups:history, channels:read, groups:read, users:read`. The May 2025 non-Marketplace rate clamp (1 req/min, 15 items) **does not apply to internal customer-built apps**; those keep ~50+ req/min. Managed workspaces may need admin approval. |
| 9 | Apple Calendar | iCloud **app-specific password** (requires Apple ID 2FA), Basic auth over CalDAV | `tsdav` discovery (`caldav.icloud.com` → partition host), then `sync-collection` / ctag+etag diff | Create event (PUT VEVENT) | Cross-platform. iCloud accepts only app-specific passwords for third-party clients. |
| 10 | Asana | PAT | `GET /tasks?project=…&modified_since=cursor` per project (works on free plans; the events API needs per-resource sync tokens, capped at 100 events) | Create/update task | 150 req/min on free, 1,500 on paid, per token; 429 + `Retry-After`. |
| 11 | PostHog | Personal API key (scopes `query:read`, `insight:read`), project id, region host (us/eu) | Daily: list saved insights, run each via `POST /api/projects/:id/query/` (HogQL), store a snapshot document per insight per day | None | Query endpoint rate limit is team-wide; docs disagree between 120/h and 2,400/h (re-verify). Keep the default daily schedule and ≤ 50 insights. |
| 12 | Notion Calendar | Virtual: no credentials of its own | Merges Google Calendar events + Notion data-source rows with a date property | None | **Confirmed: no public data API.** Notion Calendar only has a local deep-link API for opening events, which Rocky uses to add "open in Notion Calendar" links. |

## Phase 4 re-verification (2026-10-06)

- **GitHub:** API version header `X-GitHub-Api-Version: 2026-03-10` (2022-11-28 is the default if omitted). 2026-03-10 removed the singular `assignee` on issue endpoints (use `assignees[]`) and `merge_commit_sha` from PRs. Secondary limits return 403/429 with `retry-after`, or wait ≥ 1 min. The `github-authentication-token-expiration` header is not in the current docs: health uses it only when present.
- **Notion:** `2026-03-11` is still the latest version. Search returns `request_status: {type: "complete"|"incomplete"}`; data-source rows are pages (`parent.type = data_source_id`), so one search covers pages and rows. 429 carries `Retry-After` and, since 2026-09-24, `additional_data.retry_after` in the body. Store the page `url` the API returns (app links moved to `app.notion.com` in some surfaces). (re-verify) The data-source query reference still lists `is_archived`.
- **Google OAuth:** loopback `127.0.0.1:<port>`, PKCE S256 recommended; Desktop clients send `client_secret` in the token exchange. Testing-mode apps still get 7-day refresh tokens.
- **Gmail:** quota per call changed 2026-05-01: `messages.list` 5, `messages.get` 20, `threads.get` 40, `history.list` 2 units; 6,000 units/min per user. A history id is valid for at least about a week; 404 → full resync.
- **Calendar:** `syncToken` can't be combined with `timeMin`/`timeMax`/`q`/`orderBy`; `nextSyncToken` only on the last page; 410 → clear and full sync.
- **Drive:** Docs export to `text/markdown` is supported; exports are capped at 10 MB; `startPageToken` doesn't expire.
- **Not in Phase 4:** Google write executors (drafts, events, source pack) arrive in Phase 6 with their write scopes; GitHub commits and PR review comments, Gmail attachments and Drive shared drives are follow-ups.

## Phase 7 re-verification (2026-10-07)

- **Linear:** `POST https://api.linear.app/graphql`, personal key in `Authorization` without `Bearer`. Issues paged with `first`/`after` and `filter: {updatedAt: {gt}}`, `includeArchived: true` (archived issues become tombstones). Create takes `teamId` (looked up from the team key); update accepts the `ENG-123` identifier. Idempotency: a hidden `<!-- rocky:key -->` marker in the description, searched with `description: {contains}` before creating.
- **Todoist:** unified API v1 `/api/v1/sync` (form-encoded). Writes are sync commands; Todoist runs a command uuid once, so the uuid is derived from the idempotency key. A full sync returns only active tasks, so no presence list is sent (completed tasks stay as history); deletions arrive as `is_deleted`.
- **Slack:** **polling, not Socket Mode** (decision for V1): `conversations.history` per member channel every 5 minutes, one document per channel per UTC day, rebuilt from the start of the last seen day; thread replies via `conversations.replies` (up to 50 threads per channel per sync; replies to threads older than that day are picked up only when the parent day is re-read). Bot token only; no app-level token. Drafts never post: `chat.postMessage` and friends are banned by the no-send test. Socket Mode is a follow-up.
- **Apple Calendar:** CalDAV written by hand instead of `tsdav`, so requests go through the SDK http wrapper (retries, rate limits, fixture replay). Discovery `caldav.icloud.com` → `current-user-principal` → `calendar-home-set` → calendars with VEVENT; RFC 6578 `sync-collection` (404 entries are tombstones; an invalid token restarts from an empty token) and `calendar-multiget`. Recurring events are stored once with their RRULE text (no expansion yet). Writes PUT a new `.ics` with `If-None-Match: *` and a UID derived from the idempotency key (412 = already created). **No guests** on created events: iCloud sends invitations itself.
- **Asana:** `GET /tasks?project=…|workspace=…&assignee=me&modified_since=…` with offset pagination. Deleted tasks are not reported by this endpoint (they stay until removed by hand). Create checks for a task with the same name in the project from the last 10 minutes before creating (Asana has no idempotency keys).
- **PostHog:** `GET /api/projects/:id/insights/?saved=true&basic=true` then `/insights/:id/?refresh=blocking` per insight (the `/environments/` path is deprecated). Query reads: 2,400/h, 240/min, 3 concurrent; Rocky syncs once a day, at most 50 insights, one dated snapshot document each.
- **Notion Calendar:** still no data API. The local deep link `cron://showEvent?accountEmail=&iCalUID=&startDate=&endDate=&title=&ref=` opens an event; Google Calendar events now store `iCalUID` for it.

## Archive importers (no live APIs)

| Source | Export format | Anchor |
|---|---|---|
| WhatsApp | "Export chat" `.txt` (or zip with media). Date format depends on locale | line number + timestamp |
| Discord | Data package `messages/c<id>/messages.json` (or `.csv` in older packages) + `channel.json` | message id |
| Instagram | "Download your information" JSON, `messages/inbox/*/message_*.json` (text is Latin-1-escaped UTF-8, so it needs decoding) | thread + timestamp |
| X | Archive `data/tweets.js`, a JS assignment wrapper (`window.YTD.tweets.part0 = [...]`) | tweet id |
| LinkedIn | CSVs: `messages.csv`, `Connections.csv` | conversation id + date |

Formats drift. Each parser has fixtures per known version and fails with a clear message naming the unrecognized file.

Decisions (Phase 8):
- **Documents:** one per conversation per month, `sourceType: chat`, stored under the pseudo connector `import:<format>` with `meta.archive` naming the export (list and remove group by it). Re-imports are idempotent because unchanged content is skipped.
- **Units:** consecutive messages are grouped into bursts (a new one after 30 min of silence or ~1,500 characters), each anchored at its first message (`{kind: "message", messageId, threadId}`). One unit per message would give thousands of one-line chunks; bursts keep chunks readable while citations still open an exact message.
- **WhatsApp:** no message ids or time zone in the export. Ids are `L<line>@<ts>`, times are read as this machine's local time, and day/month order is inferred per file (a part over 12 decides; otherwise "." and 24 h mean d/m, AM/PM means m/d). Media placeholders and system lines are dropped.
- **Discord:** snowflake ids are bare JSON numbers above 2^53 and are quoted before parsing. The package holds only your own messages.
- **Instagram:** strings are re-decoded when they are Latin-1-escaped UTF-8; real Unicode is left alone. Same-millisecond messages get `#2`, `#3` suffixes.
- **LinkedIn:** `Connections.csv` starts with a "Notes:" preamble; the header row is found by its "First Name" column. Connections become one document with row anchors.
- **Zips** are streamed and only `.txt/.json/.js/.csv` entries are inflated (text capped at 512 MB), so a multi-GB WhatsApp export with media never sits in memory.

## Not built (community plugin candidates)

Outlook, Jira/Confluence, Discord bot, Teams, Mixpanel, Amplitude, Stripe, Mercury, HubSpot, Miro, Lucid, Canva, observability tools. No live WhatsApp, Instagram, X or LinkedIn integrations.

## Support tiers and nightly live tests (roadmap A2, M3)

Every connector declares a tier in code (`tier` in its definition), shown on its card and in the README:

- **supported**: passes the nightly live test against a dedicated test account.
- **experimental**: tested only against recorded, scrubbed fixtures. The default.
- **link-only**: no data access of its own (Notion Calendar).

Today none is supported. `.github/workflows/live-connectors.yml` runs `node apps/daemon/scripts/live-connectors.ts` nightly: health plus one sync batch for Gmail, Google Calendar, Google Drive, GitHub and Notion, through the same connector host code and egress allowlist as the daemon. A check whose secrets are missing is skipped. Repository secrets (maintainers; use throwaway test accounts, never a personal one):

| Secret | Value |
|---|---|
| `ROCKY_LIVE_GITHUB_TOKEN` | Fine-grained PAT with read access to one test repository |
| `ROCKY_LIVE_GITHUB_REPO` | That repository, `owner/name` |
| `ROCKY_LIVE_NOTION_TOKEN` | Internal integration token shared with a few test pages |
| `ROCKY_LIVE_GOOGLE_CLIENT_JSON` | The test project's "Desktop app" client JSON |
| `ROCKY_LIVE_GOOGLE_REFRESH_TOKEN` | A refresh token for the test Google account with the Gmail, Calendar and Drive read scopes |

Google refresh tokens for an OAuth app in "Testing" status expire after 7 days (see Sources), so the Google checks will start failing weekly unless the test project is moved to production. A connector is relabelled supported only after its check has passed for a sustained period; that is a manual code and README change, enforced to match by `packages/connectors/test/manifest.test.ts`.

Failures a user can act on are shown in plain words on the connector card: an expired or revoked token sets "needs reconnect" and stops retries; a rate limit says which app is limiting Rocky and when it tries again.

## Sources

- Todoist v2 shutdown: [airbyte issue](https://github.com/airbytehq/airbyte/issues/86899), [n8n community](https://community.n8n.io/t/todoist-api-deprecated/234235)
- Notion data sources: [upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03), [changelog](https://developers.notion.com/page/changelog)
- Notion Calendar API: [Notion help](https://www.notion.com/help/notion-calendar-connections)
- Google 7-day tokens: [Manage app audience](https://support.google.com/cloud/answer/15549945?hl=en), [Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en)
- Slack rate limits: [changelog 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- Linear: [rate limiting](https://linear.app/developers/rate-limiting)
- Asana: [rate limits](https://developers.asana.com/docs/rate-limits), [events](https://developers.asana.com/reference/getevents)
- PostHog: [API overview](https://posthog.com/docs/api), [queries](https://posthog.com/docs/api/queries)
- iCloud CalDAV: [tsDAV](https://github.com/calcom/tsDAV)
- GitHub PATs: [docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

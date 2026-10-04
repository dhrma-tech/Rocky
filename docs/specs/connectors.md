# Spec: Connector SDK and plugins

Package: `@rocky/connector-sdk` (semver'd; breaking changes need a major bump). Built-in connectors use exactly the same API as plugins.

```ts
export interface Connector<Cfg = unknown, Cur = unknown> {
  id: string;                                   // 'github'
  displayName: string;
  configSchema: ZodType<Cfg>;                   // non-secret config (repos, folders, channels)
  secrets: SecretSpec[];                        // names + descriptions; values live in keychain
  auth(ctx: AuthContext): Promise<AuthState>;   // validates stored secrets or runs OAuth
  sync(ctx: SyncContext<Cfg>, cursor?: Cur): AsyncIterable<DocumentBatch<Cur>>;
  actions(): ActionDefinition<any>[];           // see actions spec
  health(ctx: HealthContext): Promise<ConnectorHealth>;
  readOnlyCapable?: boolean;
}

export interface DocumentBatch<Cur> {
  documents: SourceDocument[];                  // normalized
  deletedExternalIds?: string[];                // tombstones from the source
  cursor: Cur;                                  // committed only after the batch is persisted
}

export interface SourceDocument {
  externalId: string; sourceType: string; title: string; uri?: string;
  author?: { name?: string; email?: string };
  createdAt: number; updatedAt: number;
  mime: string;
  body: { kind: 'text'; text: string; units?: AnchorUnit[] }      // pre-split units carry anchors
      | { kind: 'binary'; fetch(): Promise<Uint8Array>; mime: string }; // core parses (e.g. PDF)
  meta?: Record<string, unknown>;
  links?: { kind: 'parent' | 'thread' | 'mentions'; externalId: string }[];
}

export interface AnchorUnit { anchor: Anchor; text: string }      // never merged across by the chunker
export type Anchor =
  | { kind: 'text' } | { kind: 'pdf_page'; page: number }
  | { kind: 'transcript'; startMs: number; endMs: number }
  | { kind: 'message'; messageId: string; threadId?: string }
  | { kind: 'notion_block'; blockId: string; pageId: string }
  | { kind: 'github'; type: 'issue' | 'pr' | 'comment' | 'review' | 'commit'; ref: string }
  | { kind: 'event'; eventId: string } | { kind: 'row'; rowId: string; database?: string };
```

## SyncContext provides

- `http`: a fetch wrapper with rate-limit awareness (`Retry-After`, `X-RateLimit-*`), exponential backoff with jitter, max 5 attempts, and a per-connector concurrency limit.
- `secrets.get(name)`: scoped to the connector's own secrets.
- `log`: redacted.
- `signal`: an AbortSignal for cancellation.
- `since?`: the backfill window from config.

## Runtime guarantees (core)

- The cursor is persisted only after the batch is committed, so syncs are resumable and a crash re-fetches at most one batch.
- Upsert is keyed on `(connector_id, externalId)` with `content_hash` skip.
- `deletedExternalIds` go through the DeletionService.
- One sync per connector at a time (a lock in `connector_state`).
- `health()` is called by the UI test button and after every sync. It returns `{status: ok|degraded|error|auth_expired, message, tokenExpiresAt?}`.

## OAuth helper (Google)

`sdk.oauth.loopback({ clientId, clientSecret, scopes, authUrl, tokenUrl })`:
- Starts a temporary `127.0.0.1:<random>` listener, uses PKCE, opens the browser, exchanges the code, and stores the refresh token in the keychain.
- Detects `invalid_grant` and sets `auth_expired`.

Gmail, Calendar and Drive share one Google auth record with incremental scopes.

## Plugins

- Discovery: `config.plugins: ["rocky-connector-foo", "file:///E:/my-plugins/bar"]`. Loaded with dynamic `import()`. The default export must be a `Connector` or `Connector[]`.
- A plugin manifest is defined by package.json `rocky: { sdk: "^1", connectors: [...] }`. The SDK major version is checked at load time.
- The trust model is documented in SECURITY.md: plugins run in-process, with no store access by API convention.
- Test harness: `@rocky/connector-sdk/testing` with `replayFixtures(dir)`, `runSync(connector, cursor)` and `expectIncremental()`. Every built-in connector ships fixtures recorded from real API responses with secrets and PII scrubbed.

## Built-in connector layout

```
packages/connectors/src/<id>/
  index.ts        // Connector export
  sync.ts  actions.ts  map.ts (API → SourceDocument)
  fixtures/       // recorded, scrubbed
  <id>.test.ts
  SETUP.md        // user-facing setup steps (copied into docs site)
```

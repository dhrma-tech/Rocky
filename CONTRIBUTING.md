# Contributing to Rocky

Thanks for helping. Rocky is a local-first assistant with a small set of rules that are never weakened. Read this page, [docs/PLAN.md](docs/PLAN.md) for the architecture, and [docs/SECURITY.md](docs/SECURITY.md) before changing anything that touches models, connectors or writes.

## Setup

Follow the [README quickstart](README.md#quickstart-developers) to step 2, then:

```sh
pnpm test            # unit, security and spike projects (Ollama and whisper spikes skip when not installed)
pnpm test:security   # the security suite; it must stay green
pnpm lint            # Biome (pnpm format fixes formatting)
pnpm typecheck       # tsc for the packages, the web app and the landing page
pnpm dev             # daemon and web UI in watch mode
node scripts/fresh-clone.ts   # clean-install check with a fake Ollama (what CI runs)
```

There is no build step: Node 22.18+ runs `.ts` files directly. Use erasable TypeScript only (no enums, namespaces or parameter properties) and `.ts` extensions in relative imports.

## Layout

```
apps/daemon apps/web apps/cli apps/landing
packages/core packages/contracts packages/connector-sdk packages/connectors packages/mcp packages/importers
templates/ evals/ examples/ docs/ scripts/
```

Boundaries (enforced by `packages/core/test/security/boundaries.test.ts`):
- `core` never imports concrete connectors, the MCP server or the importers.
- Only `core/src/router/gate.ts` imports model provider SDKs.
- Only `core/src/actions/service.ts` invokes executors.
- `packages/mcp` is read-only; `packages/importers` only parses.

## Rules that are never weakened

1. Every external write goes through `ActionService`, with approval bound to the payload hash. No email is ever sent, only drafted.
2. The audit log is append-only and hash-chained.
3. Every network model call goes through `ProviderGate`, which enforces local-only mode and the budget cap.
4. Answers are verified: a deterministic quote check and a verifier pass. "Not found in your sources" is a valid answer.
5. Retrieved content is untrusted data: wrapped, tool-free, never a source of tool calls.

A change that needs to bend one of these is a design discussion first, not a pull request.

## Conventions

- TypeScript strict, ESM. zod at every boundary (HTTP, config, model output, connector payloads).
- IDs are ULIDs. Times are integer milliseconds UTC in the database.
- Model IDs and prices live in `config/*.yaml`, never in code.
- Tests ship with every feature (Vitest). Connector tests use recorded, scrubbed fixtures; CI makes no live API calls.
- UI work follows [docs/DESIGN.md](docs/DESIGN.md): semantic tokens only, no colors outside its palette.
- Write invisible characters as `\u` escapes; `source-hygiene.test.ts` fails on raw zero-width or bidi characters.
- Small commits with short, precise messages (`feat(scope): …`, `fix(scope): …`, `docs: …`).

## Secrets

Never commit secrets. User tokens live in the OS keychain only (`@napi-rs/keyring`), never in `.env`, the database or logs. We recommend a pre-commit secret scan with [gitleaks](https://github.com/gitleaks/gitleaks):

```sh
gitleaks protect --staged
```

## Dependencies

Ask in an issue before adding a dependency that is large, unmaintained, or under a restrictive or unknown license (GPL, AGPL, SSPL). Permissive, small, maintained packages are fine; pin exact versions.

## Writing a connector plugin

Connectors bring data in (and, with approval, write back). Built-in connectors and plugins use the same SDK, `packages/connector-sdk`. A complete, tested example is [examples/rss-plugin](examples/rss-plugin); `packages/connector-sdk/test/example-plugin.test.ts` loads it the way Rocky does.

**1. The package.** An ES module whose default export is a connector (or an array of them). `package.json` declares the SDK major version it targets:

```json
{
  "name": "rocky-plugin-rss",
  "type": "module",
  "main": "index.js",
  "rocky": { "sdk": "^1" },
  "dependencies": { "zod": "^4.2.0" }
}
```

Publish JavaScript. Node does not strip TypeScript types inside `node_modules`, so a `.ts` entry only works when loaded from a local folder.

**2. The connector.** The shape is the `Connector` type in `packages/connector-sdk/src/types.ts`:

```js
import { z } from "zod";

export default {
  id: "rss",                                   // lowercase, 2–40 chars: [a-z0-9-]
  displayName: "RSS feed",
  permissions: "Reads one public feed; never writes",   // shown on the connector card
  configSchema: z.object({ url: z.url() }),    // validates the config; the catalog exposes it as JSON Schema
  secrets: [],                                 // e.g. [{ name: "token", label: "API token" }]
  defaultIntervalMin: 60,

  async *sync(ctx, cursor) {
    // ctx.http: rate-limited fetch with retries. ctx.secrets: this connector's keys only.
    // ctx.since: start of the backfill window. ctx.signal: aborts on shutdown.
    const xml = await (await ctx.http.fetch(ctx.config.url)).text();
    const documents = [/* SourceDocument objects, see below */];
    yield { documents, cursor: { /* anything JSON; you get it back next time */ } };
  },

  async health(ctx) {
    const res = await ctx.http.fetch(ctx.config.url);
    return res.ok ? { status: "ok", message: "Feed reachable" } : { status: "error", message: `HTTP ${res.status}` };
  },
};
```

**3. Documents.** Each `SourceDocument` has a stable `externalId`, a `sourceType` (see `SourceTypeSchema` in `packages/contracts/src/memory.ts`), `title`, `uri`, timestamps, `mime` and a body. Split the body into **units** with anchors (`{ kind: "message", messageId }`, `{ kind: "row", rowId }`, …): chunks never cross a unit, and a citation opens its unit's anchor. Rocky persists each batch, and only then stores its cursor, so a crash re-fetches at most one batch. Re-sending unchanged content costs nothing. Report deletions with `deletedExternalIds`, or send `presentExternalIds` on a full sweep.

**4. Writes (optional).** `actions()` returns typed actions with a zod `schema`, a `risk`, a `describe()` for the approval card and an `execute()`. Rocky only calls `execute` after the user approves that exact payload; use `ctx.idempotencyKey` so a retry never writes twice. Call fixed endpoints only, never a URL taken from the payload.

**5. Test it** with `@rocky/connector-sdk/testing` (inside this repo): `replay()` serves recorded HTTP exchanges and fails on any unexpected request, `runSync()` runs a sync, and `expectIncremental()` checks that a second sync fetches only deltas.

**6. Install it.** Add the package name (installed in the data dir) or a `file:` URL to `plugins` in `rocky.yaml`, then restart the daemon:

```yaml
plugins:
  - file:///E:/code/rocky-plugin-rss
```

Plugins run in-process with the daemon's privileges and get only the SDK context, never a database handle. That is a convention, not a sandbox: install only plugins you trust.

## Template packs

Routines and prompts are Markdown and YAML in `templates/`. See [templates/README.md](templates/README.md). Users customize a pack with `rocky templates eject <pack>`.

## Reporting security issues

Please do not open a public issue for a vulnerability. Email the maintainer listed on the GitHub profile, with steps to reproduce.

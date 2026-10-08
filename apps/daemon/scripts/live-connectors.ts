/**
 * Nightly live checks for the connectors that are candidates for "supported" (roadmap A2, M3).
 * Each check runs health plus the first sync batch against a real test account, through the same
 * connector host code the daemon uses (egress allowlist included), then stops. Credentials come
 * from environment variables (GitHub Actions secrets); a check whose secrets are missing is
 * skipped, so the workflow is green until test accounts exist. Never prints a secret.
 *
 *   node apps/daemon/scripts/live-connectors.ts [--json]
 */
import { pathToFileURL } from "node:url";
import { builtinConnectors } from "@rocky/connectors";
import {
  ConnectorRegistry,
  InProcessConnectorHost,
  memorySecrets,
  type SecretName,
} from "@rocky/core";

export interface LiveCheck {
  id: string;
  /** Environment variables that must all be set. */
  env: string[];
  config: (env: NodeJS.ProcessEnv) => unknown;
  secrets: (env: NodeJS.ProcessEnv) => Record<string, string>;
}

const google = (id: string): LiveCheck => ({
  id,
  env: ["ROCKY_LIVE_GOOGLE_CLIENT_JSON", "ROCKY_LIVE_GOOGLE_REFRESH_TOKEN"],
  config: () => ({ backfillDays: 7 }),
  secrets: (env) => {
    const installed = (
      JSON.parse(env.ROCKY_LIVE_GOOGLE_CLIENT_JSON ?? "{}") as {
        installed?: unknown;
      }
    ).installed;
    return {
      "google-oauth.client": JSON.stringify(installed ?? {}),
      "google-oauth.refresh": env.ROCKY_LIVE_GOOGLE_REFRESH_TOKEN ?? "",
    };
  },
});

/** The roadmap's five: Gmail, Google Calendar, Drive, GitHub and Notion. */
export const LIVE_CHECKS: LiveCheck[] = [
  google("gmail"),
  google("gcal"),
  google("gdrive"),
  {
    id: "github",
    env: ["ROCKY_LIVE_GITHUB_TOKEN", "ROCKY_LIVE_GITHUB_REPO"],
    config: (env) => ({ repos: [env.ROCKY_LIVE_GITHUB_REPO], backfillDays: 30 }),
    secrets: (env) => ({ "github.token": env.ROCKY_LIVE_GITHUB_TOKEN ?? "" }),
  },
  {
    id: "notion",
    env: ["ROCKY_LIVE_NOTION_TOKEN"],
    config: () => ({ backfillDays: 30 }),
    secrets: (env) => ({ "notion.token": env.ROCKY_LIVE_NOTION_TOKEN ?? "" }),
  },
];

export interface LiveResult {
  id: string;
  outcome: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

export async function runLiveChecks(
  env: NodeJS.ProcessEnv,
  opts: { fetch?: typeof fetch; checks?: LiveCheck[]; now?: () => number } = {},
): Promise<LiveResult[]> {
  const now = opts.now ?? Date.now;
  const registry = new ConnectorRegistry();
  for (const c of builtinConnectors) registry.register(c);
  const out: LiveResult[] = [];
  for (const check of opts.checks ?? LIVE_CHECKS) {
    const start = now();
    const missing = check.env.filter((k) => !env[k]);
    if (missing.length) {
      out.push({ id: check.id, outcome: "skip", detail: `not set: ${missing.join(", ")}`, ms: 0 });
      continue;
    }
    const secrets = memorySecrets();
    for (const [k, v] of Object.entries(check.secrets(env))) secrets.set(k as SecretName, v);
    const host = new InProcessConnectorHost({
      registry,
      secrets,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    try {
      const def = registry.get(check.id);
      if (!def) throw new Error(`unknown connector ${check.id}`);
      const config = def.configSchema.parse(check.config(env));
      const health = await host.health(check.id, config);
      if (health.status !== "ok" && health.status !== "degraded")
        throw new Error(`health ${health.status}: ${health.message}`);
      const stream = host.sync(
        { kind: check.id, config, cursor: null, since: now() - 7 * 86_400_000 },
        () => {},
      );
      let docs = 0;
      for await (const batch of stream.batches) {
        docs = batch.documents.length;
        stream.abort();
        break; // one batch is enough to prove the shape against the real API
      }
      out.push({
        id: check.id,
        outcome: "pass",
        detail: `health ${health.status}; first batch ${docs} document(s); ${stream.requests()} request(s)`,
        ms: now() - start,
      });
    } catch (err) {
      out.push({
        id: check.id,
        outcome: "fail",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
        ms: now() - start,
      });
    } finally {
      await host.close();
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = await runLiveChecks(process.env);
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else
    for (const r of results)
      console.log(`${r.outcome.toUpperCase().padEnd(4)} ${r.id.padEnd(7)} ${r.detail}`);
  if (results.every((r) => r.outcome === "skip"))
    console.log("No live test credentials are set; every check was skipped.");
  process.exitCode = results.some((r) => r.outcome === "fail") ? 1 : 0;
}

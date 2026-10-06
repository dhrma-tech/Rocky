import fs from "node:fs";
import type { Connector } from "@rocky/contracts";
import { openRuntime, type Runtime, resolveDataDir } from "@rocky/core";
import { readSecret } from "./commands.ts";

/**
 * `rocky connectors …`: set up and run connectors from the terminal. Works with or without the
 * daemon (both use the same DB; a per-connector lock keeps syncs from overlapping).
 */

async function withRuntime<T>(
  dataDir: string | undefined,
  fn: (rt: Runtime) => Promise<T>,
): Promise<T> {
  const { registerConnectors } = await import("@rocky/daemon");
  const { dir } = resolveDataDir({ flag: dataDir });
  const rt = await openRuntime({ dataDir: dir });
  try {
    await registerConnectors(rt, (m) => console.error(m));
    return await fn(rt);
  } finally {
    await rt.connectors.idle();
    rt.close();
  }
}

const STATUS: Record<Connector["status"], string> = {
  connected: "Connected",
  syncing: "Syncing",
  needs_reconnect: "Needs reconnect",
  error: "Error",
  not_configured: "Not set up",
  disabled: "Disabled",
};

const ago = (ms: number | null) => {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1
    ? "just now"
    : m < 60
      ? `${m} min ago`
      : m < 2880
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
};

export function formatConnectors(list: Connector[]): string {
  if (!list.length)
    return "No connectors yet. Add one: rocky connectors add github --repos owner/name";
  return list
    .map(
      (c) =>
        `${c.id.padEnd(8)} ${STATUS[c.status].padEnd(16)} ${String(c.documentCount).padStart(6)} docs  last sync ${ago(c.lastSyncAt)}` +
        (c.message ? `\n         ${c.message}` : ""),
    )
    .join("\n");
}

export async function connectorsCommand(
  action: string,
  args: string[],
  opts: {
    dataDir?: string | undefined;
    repos?: string;
    config?: string;
    purge?: boolean;
    json?: boolean;
  },
): Promise<number> {
  return withRuntime(opts.dataDir, async (rt) => {
    const [first, second] = args;
    switch (action) {
      case "list": {
        const list = rt.connectors.list();
        console.log(opts.json ? JSON.stringify(list, null, 2) : formatConnectors(list));
        return 0;
      }
      case "catalog": {
        for (const c of rt.connectors.catalog())
          console.log(`${c.kind.padEnd(8)} ${c.displayName}: ${c.permissions}`);
        return 0;
      }
      case "add": {
        if (!first)
          throw new Error("Usage: rocky connectors add <kind> [--repos o/r,o/r2] [--config '{…}']");
        const config: Record<string, unknown> = opts.config
          ? (JSON.parse(opts.config) as Record<string, unknown>)
          : {};
        if (opts.repos) config.repos = opts.repos.split(",").map((s) => s.trim());
        const c = rt.connectors.add(first, config);
        console.log(`Added ${c.displayName}. ${c.message ?? ""}`.trim());
        return 0;
      }
      case "secret": {
        if (!first || !second) throw new Error("Usage: rocky connectors secret <kind> <name>");
        rt.connectors.setSecret(
          first,
          second,
          await readSecret(`${first} ${second} (input hidden): `),
        );
        console.log("Stored in the OS keychain.");
        return 0;
      }
      case "google-client": {
        if (!first) throw new Error("Usage: rocky connectors google-client <client_secret_….json>");
        rt.connectors.setOAuthClient("google-oauth", fs.readFileSync(first, "utf8"));
        console.log(
          "Google client stored in the OS keychain. You can delete the downloaded file now.",
        );
        return 0;
      }
      case "connect": {
        if (!first) throw new Error("Usage: rocky connectors connect <gmail|gcal|gdrive>");
        const { authUrl } = await rt.connectors.startOAuth(first);
        console.log(`Open this link to sign in with Google (waits up to 5 minutes):\n${authUrl}`);
        // Wait until the refresh token is stored (or the session closes).
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          if (rt.connectors.get(first).status !== "not_configured") break;
        }
        const c = rt.connectors.get(first);
        console.log(c.status === "not_configured" ? `Not signed in: ${c.message}` : "Signed in.");
        return c.status === "not_configured" ? 1 : 0;
      }
      case "test": {
        if (!first) throw new Error("Usage: rocky connectors test <id>");
        const h = await rt.connectors.test(first);
        console.log(`${h.status}: ${h.message}`);
        return h.status === "ok" || h.status === "degraded" ? 0 : 1;
      }
      case "sync": {
        const ids = first ? [first] : rt.connectors.list().map((c) => c.id);
        for (const id of ids) {
          await rt.connectors.sync(id);
          const run = rt.connectors.runs(id, 1)[0];
          console.log(
            run
              ? `${id}: ${run.status} +${run.added} ~${run.updated} -${run.deleted} (${run.requests} requests)${run.error ? `\n  ${run.error}` : ""}`
              : `${id}: skipped (${rt.connectors.get(id).message ?? "not due"})`,
          );
        }
        const n = await rt.drainJobs((m) => console.error(m));
        if (n) console.log(`embedded ${n} document(s)`);
        return 0;
      }
      case "remove": {
        if (!first) throw new Error("Usage: rocky connectors remove <id> [--purge]");
        const r = rt.connectors.remove(first, { purge: Boolean(opts.purge) });
        console.log(
          opts.purge
            ? `Removed, and deleted ${r.purged} synced document(s).`
            : "Removed. Synced documents were kept.",
        );
        return 0;
      }
      default:
        throw new Error(
          `Unknown action "${action}". Try: list, catalog, add, secret, google-client, connect, test, sync, remove`,
        );
    }
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  });
}

import fs from "node:fs";
import path from "node:path";
import { createHttp } from "./http.ts";
import type { Connector, DocumentBatch, ScopedSecrets, SourceDocument } from "./types.ts";

/**
 * Test harness (`@rocky/connector-sdk/testing`): replay recorded HTTP exchanges, run a sync, and
 * check that a second sync only asks for deltas. No network in CI.
 */

export interface Exchange {
  method?: string;
  /** Full URL; query parameter order doesn't matter. */
  url: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const normalize = (u: string) => {
  const url = new URL(u);
  url.searchParams.sort();
  return url.toString();
};

export interface Replay {
  fetch: typeof fetch;
  /** Every request made, as "METHOD url". */
  calls: string[];
  /** Exchanges that were never requested. */
  unused(): Exchange[];
}

/**
 * Serves exchanges in order per (method, URL). An unmatched request throws, so a test fails as soon
 * as a connector asks for something it shouldn't (that is how delta syncs are verified).
 */
export function replay(exchanges: Exchange[]): Replay {
  const queue = exchanges.map((e) => ({
    ...e,
    key: `${(e.method ?? "GET").toUpperCase()} ${normalize(e.url)}`,
    used: false,
  }));
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${normalize(url)}`;
    calls.push(`${method} ${url}`);
    const hit = queue.find((e) => !e.used && e.key === key);
    if (!hit) throw new Error(`Unexpected request in replay: ${key}`);
    hit.used = true;
    const body =
      hit.body === undefined
        ? ""
        : typeof hit.body === "string"
          ? hit.body
          : JSON.stringify(hit.body);
    return new Response(body, {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json", ...hit.headers },
    });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, unused: () => queue.filter((e) => !e.used) };
}

/** Loads `<dir>/<name>.json` (an Exchange[]). */
export function replayFixtures(dir: string, ...names: string[]): Replay {
  return replay(
    names.flatMap(
      (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), "utf8")) as Exchange[],
    ),
  );
}

export function memorySecrets(values: Record<string, string> = {}): ScopedSecrets {
  const m = new Map(Object.entries(values));
  return { get: (n) => m.get(n) ?? null, set: (n, v) => void m.set(n, v) };
}

export interface SyncResult<Cur> {
  batches: DocumentBatch<Cur>[];
  documents: SourceDocument[];
  deleted: string[];
  cursor: Cur | undefined;
  requests: number;
  fullResync: boolean;
}

export async function runSync<Cfg, Cur>(
  connector: Connector<Cfg, Cur>,
  opts: {
    fetch: typeof fetch;
    config: Cfg;
    cursor?: Cur;
    secrets?: ScopedSecrets;
    since?: number;
    accessToken?: () => Promise<string>;
  },
): Promise<SyncResult<Cur>> {
  const http = createHttp({ fetch: opts.fetch, sleep: async () => {}, random: () => 0 });
  const batches: DocumentBatch<Cur>[] = [];
  for await (const b of connector.sync(
    {
      config: opts.config,
      http,
      secrets: opts.secrets ?? memorySecrets(),
      log: () => {},
      signal: new AbortController().signal,
      since: opts.since ?? Date.UTC(2026, 6, 1),
      ...(opts.accessToken ? { accessToken: opts.accessToken } : {}),
    },
    opts.cursor,
  ))
    batches.push(b);
  return {
    batches,
    documents: batches.flatMap((b) => b.documents),
    deleted: batches.flatMap((b) => b.deletedExternalIds ?? []),
    cursor: batches.at(-1)?.cursor ?? opts.cursor,
    requests: http.requests,
    fullResync: batches.some((b) => b.fullResync),
  };
}

/** Asserts a follow-up sync made at most `max` requests and fetched only the changed items. */
export function expectIncremental(
  second: SyncResult<unknown>,
  opts: { maxRequests: number; changedIds: string[] },
): void {
  if (second.requests > opts.maxRequests)
    throw new Error(`Incremental sync made ${second.requests} requests (max ${opts.maxRequests})`);
  const got = second.documents.map((d) => d.externalId).sort();
  const want = [...opts.changedIds].sort();
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `Incremental sync returned ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
    );
}

import {
  AuthExpired,
  type Connector,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * PostHog (CONNECTORS.md #11). Personal API key with insight:read (and query:read). Verified
 * 2026-10-07: GET /api/projects/:id/insights/ (the /environments/ path is deprecated) with
 * saved, basic, limit; GET /api/projects/:id/insights/:id/?refresh=blocking returns fresh
 * results in `result`. Query reads are limited (2,400/h, 3 concurrent): one sync per day,
 * at most 50 insights. Each insight becomes one snapshot document per day. No writes.
 */

const MAX_POINTS = 14;
const MAX_ROWS = 20;

export const PosthogConfigSchema = z.object({
  /** https://us.posthog.com, https://eu.posthog.com, or a self-hosted URL. */
  host: z.url().default("https://us.posthog.com"),
  projectId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  maxInsights: z.number().int().min(1).max(50).default(20),
});
export type PosthogConfig = z.infer<typeof PosthogConfigSchema>;
export interface PosthogCursor {
  /** UTC day of the last snapshot, so a second sync that day does nothing. */
  day?: string;
}

interface Insight {
  id: number;
  short_id: string;
  name: string | null;
  derived_name?: string | null;
  description?: string | null;
  result?: unknown;
  last_refresh?: string | null;
}

function key(secrets: { get(n: string): string | null }): string {
  const k = secrets.get("token");
  if (!k) throw new AuthExpired("Add a PostHog personal API key on the Connectors page.");
  return k;
}

async function get<T>(http: Http, apiKey: string, url: string): Promise<T> {
  const res = await http.fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (res.status === 401 || res.status === 403)
    throw new AuthExpired(
      "PostHog rejected the API key or it lacks the insight:read scope. Create a new key.",
    );
  if (!res.ok) throw new HttpError(res.status, url, text);
  return JSON.parse(text) as T;
}

const num = (v: unknown) => (typeof v === "number" ? Number(v.toFixed(2)).toString() : String(v));

/** An insight's result as plain text: trend series, funnel steps, tables, else compact JSON. */
export function renderResult(result: unknown): string {
  if (
    Array.isArray(result) &&
    result.length &&
    typeof result[0] === "object" &&
    result[0] !== null
  ) {
    const rows = result as Record<string, unknown>[];
    if ("data" in (rows[0] as object) && Array.isArray(rows[0]?.data)) {
      return rows
        .slice(0, MAX_ROWS)
        .map((s) => {
          const data = (s.data as unknown[]) ?? [];
          const days = (s.days as string[] | undefined) ?? (s.labels as string[] | undefined) ?? [];
          const recent = data
            .slice(-MAX_POINTS)
            .map(
              (v, i) =>
                `${days[data.length - Math.min(data.length, MAX_POINTS) + i] ?? i}: ${num(v)}`,
            );
          const total = s.aggregated_value ?? s.count;
          return `${String(s.label ?? s.action ?? "series")}${total !== undefined ? ` (total ${num(total)})` : ""}\n${recent.join(", ")}`;
        })
        .join("\n\n");
    }
    if (
      "count" in (rows[0] as object) &&
      ("name" in (rows[0] as object) || "custom_name" in (rows[0] as object))
    )
      return rows
        .slice(0, MAX_ROWS)
        .map((s, i) => `Step ${i + 1}: ${String(s.custom_name ?? s.name)}: ${num(s.count)}`)
        .join("\n");
  }
  if (result && typeof result === "object" && "columns" in result && "results" in result) {
    const t = result as { columns: string[]; results: unknown[][] };
    return [
      t.columns.join(" | "),
      ...t.results.slice(0, MAX_ROWS).map((r) => r.map(num).join(" | ")),
    ].join("\n");
  }
  const json = JSON.stringify(result ?? null);
  return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
}

export function snapshotDocument(
  cfg: PosthogConfig,
  i: Insight,
  day: string,
  now: number,
): SourceDocument {
  const name = i.name || i.derived_name || `Insight ${i.short_id}`;
  const text = [
    i.description ? `${i.description}\n` : "",
    `Snapshot for ${day}${i.last_refresh ? ` (computed ${i.last_refresh})` : ""}:`,
    renderResult(i.result),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    externalId: `${i.id}:${day}`,
    sourceType: "analytics",
    title: `${name} (${day})`,
    uri: `${cfg.host.replace(/\/$/, "")}/project/${cfg.projectId}/insights/${i.short_id}`,
    createdAt: now,
    updatedAt: now,
    mime: "text/plain",
    body: {
      kind: "text",
      units: [{ anchor: { kind: "row", rowId: i.short_id }, heading: name, text }],
    },
    meta: { insightId: i.id, shortId: i.short_id, name, day },
  };
}

export const posthog: Connector<PosthogConfig, PosthogCursor> = {
  id: "posthog",
  tier: "experimental",
  egress: (c) => [c.host],
  displayName: "PostHog",
  permissions: "Reads saved insights once a day as dated snapshots; never writes",
  configSchema: PosthogConfigSchema,
  secrets: [
    {
      name: "token",
      label: "personal API key",
      description:
        "PostHog → Settings → Personal API keys → Create key with scopes insight:read and query:read. The project id is in Project settings.",
    },
  ],
  defaultIntervalMin: 1440,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const k = key(ctx.secrets);
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (cursor?.day === day) {
      yield { documents: [], cursor };
      return;
    }
    const base = `${ctx.config.host.replace(/\/$/, "")}/api/projects/${ctx.config.projectId}/insights`;
    const list = await get<{ results: Insight[] }>(
      ctx.http,
      k,
      `${base}/?saved=true&basic=true&limit=${ctx.config.maxInsights}`,
    );
    for (const meta of list.results.slice(0, ctx.config.maxInsights)) {
      const i = await get<Insight>(ctx.http, k, `${base}/${meta.id}/?refresh=blocking`);
      yield { documents: [snapshotDocument(ctx.config, i, day, now)], cursor: cursor ?? {} };
    }
    yield { documents: [], cursor: { day } };
  },
  async health(ctx) {
    const p = await get<{ name: string }>(
      ctx.http,
      key(ctx.secrets),
      `${ctx.config.host.replace(/\/$/, "")}/api/projects/${ctx.config.projectId}/`,
    );
    return { status: "ok", message: `Connected to project ${p.name}`, account: p.name };
  },
};

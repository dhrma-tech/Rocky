import {
  type AnchorUnit,
  AuthExpired,
  type Connector,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Notion (CONNECTORS.md #4). Internal integration token; the user shares pages with it.
 * Verified 2026-10-06: Notion-Version 2026-03-11 (still the latest; `archived` → `in_trash`);
 * POST /v1/search with filter {property: "object", value: "page"} and sort by last_edited_time;
 * GET /v1/blocks/{id}/children is one level, recurse on has_children; 429 + Retry-After
 * (~3 req/s); search may stop early with request_status "incomplete".
 * Data-source rows are pages too (parent.type = "data_source_id"), so search covers them.
 */

const API = "https://api.notion.com/v1";
const VERSION = "2026-03-11";
const MAX_DEPTH = 4;

export const NotionConfigSchema = z.object({
  backfillDays: z.number().int().min(1).max(3650).optional(),
  /** Days between full sweeps that remove pages no longer shared with the integration. */
  sweepDays: z.number().int().min(1).max(90).default(7),
});
export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export interface NotionCursor {
  /** Highest last_edited_time seen (ISO). */
  lastEdited?: string;
  /** When the last full sweep finished (ms). */
  lastSweep?: number;
}

interface RichText {
  plain_text: string;
}
interface NPage {
  object: "page";
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  parent: { type: string; data_source_id?: string; page_id?: string };
  properties: Record<string, { type: string; [k: string]: unknown }>;
  created_by?: { id: string };
}
interface NBlock {
  id: string;
  type: string;
  has_children: boolean;
  [k: string]: unknown;
}
interface NList<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  request_status?: { type: string; incomplete_reason?: string };
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "notion-version": VERSION,
  "content-type": "application/json",
});

function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add the Notion integration token on the Connectors page.");
  return t;
}

async function call<T>(http: Http, tok: string, url: string, body?: unknown): Promise<T> {
  const res = await http.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(tok),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status === 401)
    throw new AuthExpired("Notion rejected the token. Paste a new integration token.");
  if (!res.ok) throw new HttpError(res.status, url, text);
  return JSON.parse(text) as T;
}

const plain = (rt: unknown) =>
  Array.isArray(rt) ? (rt as RichText[]).map((r) => r.plain_text).join("") : "";

/** One block as a markdown line; null for blocks without text (dividers, images, embeds). */
export function blockText(b: NBlock): string | null {
  const data = b[b.type] as
    | {
        rich_text?: unknown;
        checked?: boolean;
        language?: string;
        title?: string;
        cells?: unknown[];
      }
    | undefined;
  const t = plain(data?.rich_text);
  switch (b.type) {
    case "heading_1":
      return `# ${t}`;
    case "heading_2":
      return `## ${t}`;
    case "heading_3":
      return `### ${t}`;
    case "bulleted_list_item":
      return `- ${t}`;
    case "numbered_list_item":
      return `1. ${t}`;
    case "to_do":
      return `- [${data?.checked ? "x" : " "}] ${t}`;
    case "quote":
      return `> ${t}`;
    case "code":
      return `\`\`\`${data?.language ?? ""}\n${t}\n\`\`\``;
    case "child_page":
    case "child_database":
      return data?.title
        ? `(${b.type === "child_page" ? "Page" : "Database"}: ${data.title})`
        : null;
    case "table_row":
      return `| ${(data?.cells ?? []).map((c) => plain(c)).join(" | ")} |`;
    case "paragraph":
    case "callout":
    case "toggle":
    case "meeting_notes":
      return t || null;
    default:
      return t || null;
  }
}

async function children(http: Http, tok: string, id: string): Promise<NBlock[]> {
  const out: NBlock[] = [];
  let cursor: string | null = null;
  do {
    const page: NList<NBlock> = await call<NList<NBlock>>(
      http,
      tok,
      `${API}/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

/** Text of a block and its nested children (child pages are separate documents). */
async function blockTree(http: Http, tok: string, b: NBlock, depth: number): Promise<string[]> {
  const own = blockText(b);
  const lines = own ? [own] : [];
  if (b.has_children && depth < MAX_DEPTH && b.type !== "child_page" && b.type !== "child_database")
    for (const c of await children(http, tok, b.id))
      lines.push(
        ...(await blockTree(http, tok, c, depth + 1)).map((l) =>
          b.type.endsWith("list_item") || b.type === "toggle" ? `  ${l}` : l,
        ),
      );
  return lines;
}

export function pageTitle(p: NPage): string {
  for (const prop of Object.values(p.properties))
    if (prop.type === "title") return plain(prop.title) || "Untitled";
  return "Untitled";
}

/** A data-source row's properties as "Name: value" lines. */
export function propertyLines(p: NPage): string[] {
  const out: string[] = [];
  for (const [name, prop] of Object.entries(p.properties)) {
    if (prop.type === "title") continue;
    const v = prop[prop.type] as unknown;
    let s = "";
    if (prop.type === "rich_text") s = plain(v);
    else if (prop.type === "select" || prop.type === "status")
      s = (v as { name?: string } | null)?.name ?? "";
    else if (prop.type === "multi_select")
      s = ((v as { name: string }[]) ?? []).map((x) => x.name).join(", ");
    else if (prop.type === "date") {
      const d = v as { start?: string; end?: string | null } | null;
      s = d?.start ? `${d.start}${d.end ? ` → ${d.end}` : ""}` : "";
    } else if (prop.type === "checkbox") s = v ? "yes" : "no";
    else if (
      prop.type === "number" ||
      prop.type === "url" ||
      prop.type === "email" ||
      prop.type === "phone_number"
    )
      s = v == null ? "" : String(v);
    else if (prop.type === "people")
      s = ((v as { name?: string }[]) ?? [])
        .map((x) => x.name ?? "")
        .filter(Boolean)
        .join(", ");
    if (s) out.push(`${name}: ${s}`);
  }
  return out;
}

export async function pageToDocument(http: Http, tok: string, p: NPage): Promise<SourceDocument> {
  const title = pageTitle(p);
  const isRow = p.parent.type === "data_source_id";
  const units: AnchorUnit[] = [];
  if (isRow) {
    const props = propertyLines(p);
    if (props.length) units.push({ anchor: { kind: "row", rowId: p.id }, text: props.join("\n") });
  }
  // Top-level blocks grouped under their heading: one anchored unit per section.
  let group: { id: string; lines: string[] } | null = null;
  const flush = () => {
    if (group?.lines.length)
      units.push({
        anchor: { kind: "notion_block", blockId: group.id, pageId: p.id },
        text: group.lines.join("\n"),
      });
    group = null;
  };
  for (const b of await children(http, tok, p.id)) {
    if (b.type.startsWith("heading_")) flush();
    const lines = await blockTree(http, tok, b, 0);
    if (!lines.length) continue;
    group ??= { id: b.id, lines: [] };
    group.lines.push(...lines);
  }
  flush();
  return {
    externalId: p.id,
    sourceType: "notion",
    title,
    uri: p.url,
    createdAt: Date.parse(p.created_time),
    updatedAt: Date.parse(p.last_edited_time),
    mime: "text/markdown",
    body: {
      kind: "text",
      units: units.length ? units : [{ anchor: { kind: "text" }, text: title }],
    },
    meta: {
      kind: isRow ? "row" : "page",
      // Notebook rules match a page "with descendants" through this parent chain.
      ...(p.parent.page_id ? { parentId: p.parent.page_id } : {}),
      ...(p.parent.data_source_id ? { dataSourceId: p.parent.data_source_id } : {}),
    },
  };
}

/** Pages visible to the integration, newest edit first; stops once older than `after`. */
async function* search(
  http: Http,
  tok: string,
  log: (m: string) => void,
  after?: string,
): AsyncGenerator<NPage[]> {
  let cursor: string | null = null;
  do {
    const res: NList<NPage> = await call<NList<NPage>>(http, tok, `${API}/search`, {
      filter: { property: "object", value: "page" },
      sort: { timestamp: "last_edited_time", direction: "descending" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (res.request_status?.type === "incomplete")
      log(
        `Notion search stopped early (${res.request_status.incomplete_reason ?? "unknown"}); the rest is picked up next sync.`,
      );
    const fresh = after ? res.results.filter((p) => p.last_edited_time >= after) : res.results;
    yield fresh;
    if (after && fresh.length < res.results.length) return; // Sorted: everything after this is older.
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

export const notion: Connector<NotionConfig, NotionCursor> = {
  id: "notion",
  displayName: "Notion",
  permissions: "Reads pages and database rows shared with the integration",
  configSchema: NotionConfigSchema,
  secrets: [
    {
      name: "token",
      label: "integration token",
      description:
        "notion.so/profile/integrations → New internal integration. Then share pages with it (••• → Connections).",
    },
  ],
  defaultIntervalMin: 15,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const tok = token(ctx.secrets);
    const now = Date.now();
    const sweep = !cursor?.lastSweep || now - cursor.lastSweep > ctx.config.sweepDays * 86_400_000;
    const floor = cursor?.lastEdited ?? new Date(ctx.since).toISOString();
    let lastEdited = cursor?.lastEdited;
    const seen: string[] = [];
    for await (const pages of search(ctx.http, tok, ctx.log, sweep ? undefined : floor)) {
      const documents: SourceDocument[] = [];
      const trashed: string[] = [];
      for (const p of pages) {
        if (p.in_trash) {
          trashed.push(p.id);
          continue;
        }
        seen.push(p.id);
        if (!lastEdited || p.last_edited_time > lastEdited) lastEdited = p.last_edited_time;
        // During a sweep every page is listed, but only changed ones are fetched again.
        if (p.last_edited_time < floor && cursor?.lastEdited) continue;
        documents.push(await pageToDocument(ctx.http, tok, p));
      }
      // Results come newest first, so the cursor only moves once the whole listing is done; a
      // crash part-way re-lists from the old cursor (re-fetching is idempotent).
      yield { documents, deletedExternalIds: trashed, cursor: cursor ?? {} };
    }
    yield {
      documents: [],
      ...(sweep ? { presentExternalIds: seen } : {}),
      cursor: {
        ...cursor,
        ...(lastEdited ? { lastEdited } : {}),
        ...(sweep ? { lastSweep: now } : {}),
      },
    };
  },
  async health(ctx) {
    const tok = token(ctx.secrets);
    const me = await call<{ name?: string; bot?: { workspace_name?: string } }>(
      ctx.http,
      tok,
      `${API}/users/me`,
    );
    const res = await call<NList<NPage>>(ctx.http, tok, `${API}/search`, {
      filter: { property: "object", value: "page" },
      page_size: 1,
    });
    const workspace = me.bot?.workspace_name ?? "Notion";
    if (!res.results.length)
      return {
        status: "degraded",
        message: `Connected to ${workspace}, but no pages are shared with the integration yet (••• → Connections).`,
        account: workspace,
      };
    return { status: "ok", message: `Connected to ${workspace}`, account: workspace };
  },
};

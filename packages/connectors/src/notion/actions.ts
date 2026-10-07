import type { ConnectorAction, ExecContext, Http } from "@rocky/connector-sdk";
import { z } from "zod";
import { API, call, token } from "./http.ts";

/**
 * Notion writes (actions.md). Verified 2026-10-07 (Notion-Version 2026-03-11):
 * - POST /v1/pages with parent {page_id} or {data_source_id}; child pages take only a title
 *   property; content as `children` blocks (≤ 100 per request, ≤ 2,000 chars per text item).
 * - PATCH /v1/pages/{id} updates properties; PATCH /v1/blocks/{id}/children appends blocks.
 * - GET /v1/data_sources/{id} returns the property schema (names and types) for rows.
 * Idempotency: Notion has no request keys or hidden fields, so before creating, a page with the
 * same title and parent that this integration created in the last day counts as the earlier try.
 */

const MAX_BLOCKS = 100;
const MAX_TEXT = 2000;
const REUSE_WINDOW_MS = 86_400_000;

const Title = z.string().trim().min(1).max(300);
/** Plain text; "# " headings, "- " bullets and blank-line paragraphs become blocks. */
const Body = z.string().max(50_000);
/** Row values by property name: text, number, checkbox, an ISO date, or names for selects. */
const Values = z.record(
  z.string().min(1).max(200),
  z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
);

export const PageCreateSchema = z
  .object({ parentPageId: z.string().min(1), title: Title, body: Body.default("") })
  .strict();
export const PageUpdateSchema = z
  .object({ pageId: z.string().min(1), title: Title.optional(), append: Body.optional() })
  .strict()
  .refine((p) => p.title !== undefined || p.append, "set a title or text to append");
export const RowCreateSchema = z
  .object({ dataSourceId: z.string().min(1), title: Title, values: Values.default({}) })
  .strict();
export const RowUpdateSchema = z
  .object({ pageId: z.string().min(1), values: Values })
  .strict()
  .refine((p) => Object.keys(p.values).length > 0, "set at least one value");

type PageCreate = z.infer<typeof PageCreateSchema>;
type PageUpdate = z.infer<typeof PageUpdateSchema>;
type RowCreate = z.infer<typeof RowCreateSchema>;
type RowUpdate = z.infer<typeof RowUpdateSchema>;

const richText = (s: string) =>
  (s.match(new RegExp(`[\\s\\S]{1,${MAX_TEXT}}`, "g")) ?? []).map((content) => ({
    type: "text",
    text: { content },
  }));

/** Plain text → Notion blocks (headings, bullets, paragraphs), capped at 100. */
export function toBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  const block = (type: string, s: string) => ({
    object: "block",
    type,
    [type]: { rich_text: richText(s) },
  });
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*] /.test(l)))
      for (const l of lines) blocks.push(block("bulleted_list_item", l.replace(/^\s*[-*] /, "")));
    else if (lines.length === 1 && /^#{1,3} /.test(lines[0] ?? "")) {
      const l = lines[0] ?? "";
      const level = Math.min(3, l.indexOf(" "));
      blocks.push(block(`heading_${level}`, l.slice(level + 1)));
    } else blocks.push(block("paragraph", lines.join("\n")));
  }
  return blocks.slice(0, MAX_BLOCKS);
}

interface NPage {
  id: string;
  url: string;
  created_time: string;
  created_by?: { id: string };
  parent: { type: string; page_id?: string; data_source_id?: string };
  properties: Record<string, { type: string; [k: string]: unknown }>;
}
interface Schema {
  properties: Record<string, { id: string; type: string }>;
}

const plain = (rt: unknown) =>
  Array.isArray(rt) ? (rt as { plain_text: string }[]).map((r) => r.plain_text).join("") : "";
const titleOf = (p: NPage) => {
  for (const v of Object.values(p.properties)) if (v.type === "title") return plain(v.title);
  return "";
};

/** A page this integration created recently with the same title under the same parent. */
async function recentDuplicate(
  http: Http,
  tok: string,
  title: string,
  parent: { page_id?: string; data_source_id?: string },
): Promise<NPage | null> {
  const me = await call<{ id: string }>(http, tok, `${API}/users/me`);
  const found = await call<{ results: NPage[] }>(http, tok, `${API}/search`, {
    query: title,
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 10,
  });
  const norm = (s?: string) => s?.replace(/-/g, "");
  return (
    found.results.find(
      (p) =>
        titleOf(p) === title &&
        p.created_by?.id === me.id &&
        Date.now() - Date.parse(p.created_time) < REUSE_WINDOW_MS &&
        (parent.page_id
          ? norm(p.parent.page_id) === norm(parent.page_id)
          : norm(p.parent.data_source_id) === norm(parent.data_source_id)),
    ) ?? null
  );
}

/** Values → Notion property objects, by the data source's schema. Unknown names are an error. */
export function toProperties(
  schema: Schema,
  values: Record<string, string | number | boolean | null>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) {
    const prop = schema.properties[name];
    if (!prop) throw new Error(`The data source has no property "${name}"`);
    const s = v === null ? "" : String(v);
    switch (prop.type) {
      case "title":
      case "rich_text":
        out[name] = { [prop.type]: v === null ? [] : richText(s) };
        break;
      case "number":
        out[name] = { number: v === null ? null : Number(v) };
        break;
      case "checkbox":
        out[name] = { checkbox: v === true || s === "true" || s === "yes" };
        break;
      case "select":
      case "status":
        out[name] = { [prop.type]: v === null ? null : { name: s } };
        break;
      case "multi_select":
        out[name] = {
          multi_select: s
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((n) => ({ name: n })),
        };
        break;
      case "date":
        out[name] = { date: v === null ? null : { start: s } };
        break;
      case "url":
      case "email":
      case "phone_number":
        out[name] = { [prop.type]: v === null ? null : s };
        break;
      default:
        throw new Error(`Property "${name}" has type ${prop.type}, which Rocky can't set`);
    }
  }
  return out;
}

const titleProp = (schema: Schema) =>
  Object.entries(schema.properties).find(([, p]) => p.type === "title")?.[0] ?? "title";

const done = (p: NPage, reused = false) => ({
  pageId: p.id,
  url: p.url,
  ...(reused ? { reused } : {}),
});
const tokOf = (ctx: ExecContext) => token(ctx.secrets);

export const pageCreate: ConnectorAction<PageCreate> = {
  type: "notion.pageCreate",
  title: "Create Notion page",
  schema: PageCreateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Notion page ${p.parentPageId}`,
    summary: `New sub-page "${p.title}"`,
    diff: { body: p.body },
  }),
  async execute(p, ctx) {
    const tok = tokOf(ctx);
    const parent = { page_id: p.parentPageId };
    const dup = await recentDuplicate(ctx.http, tok, p.title, parent);
    if (dup) return done(dup, true);
    const page = await call<NPage>(
      ctx.http,
      tok,
      `${API}/pages`,
      { parent, properties: { title: { title: richText(p.title) } }, children: toBlocks(p.body) },
      { signal: ctx.signal },
    );
    return done(page);
  },
};

export const pageUpdate: ConnectorAction<PageUpdate> = {
  type: "notion.pageUpdate",
  title: "Update Notion page",
  schema: PageUpdateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Notion page ${p.pageId}`,
    summary: [p.title ? `Rename to "${p.title}"` : "", p.append ? "Append text" : ""]
      .filter(Boolean)
      .join("; "),
    diff: { ...(p.title ? { title: p.title } : {}), ...(p.append ? { append: p.append } : {}) },
  }),
  async execute(p, ctx) {
    const tok = tokOf(ctx);
    let page: NPage | null = null;
    if (p.title)
      page = await call<NPage>(
        ctx.http,
        tok,
        `${API}/pages/${p.pageId}`,
        { properties: { title: { title: richText(p.title) } } },
        { method: "PATCH", signal: ctx.signal },
      );
    if (p.append)
      await call(
        ctx.http,
        tok,
        `${API}/blocks/${p.pageId}/children`,
        { children: toBlocks(p.append) },
        {
          method: "PATCH",
          signal: ctx.signal,
        },
      );
    return { pageId: p.pageId, url: page?.url ?? null };
  },
};

export const rowCreate: ConnectorAction<RowCreate> = {
  type: "notion.rowCreate",
  title: "Add Notion database row",
  schema: RowCreateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Notion data source ${p.dataSourceId}`,
    summary: `New row "${p.title}"`,
    diff: p.values,
  }),
  async execute(p, ctx) {
    const tok = tokOf(ctx);
    const schema = await call<Schema>(ctx.http, tok, `${API}/data_sources/${p.dataSourceId}`);
    const parent = { data_source_id: p.dataSourceId };
    const dup = await recentDuplicate(ctx.http, tok, p.title, parent);
    if (dup) return done(dup, true);
    const page = await call<NPage>(
      ctx.http,
      tok,
      `${API}/pages`,
      { parent, properties: toProperties(schema, { ...p.values, [titleProp(schema)]: p.title }) },
      { signal: ctx.signal },
    );
    return done(page);
  },
};

export const rowUpdate: ConnectorAction<RowUpdate> = {
  type: "notion.rowUpdate",
  title: "Update Notion database row",
  schema: RowUpdateSchema,
  risk: "medium",
  describe: (p) => ({
    target: `Notion row ${p.pageId}`,
    summary: `Set ${Object.keys(p.values).join(", ")}`,
    diff: p.values,
  }),
  async execute(p, ctx) {
    const tok = tokOf(ctx);
    const row = await call<NPage>(ctx.http, tok, `${API}/pages/${p.pageId}`);
    const ds = row.parent.data_source_id;
    if (!ds) throw new Error("That page is not a database row");
    const schema = await call<Schema>(ctx.http, tok, `${API}/data_sources/${ds}`);
    const page = await call<NPage>(
      ctx.http,
      tok,
      `${API}/pages/${p.pageId}`,
      { properties: toProperties(schema, p.values) },
      { method: "PATCH", signal: ctx.signal },
    );
    return done(page);
  },
};

// biome-ignore lint/suspicious/noExplicitAny: each action has its own payload type.
export const notionActions = (): ConnectorAction<any>[] => [
  pageCreate,
  pageUpdate,
  rowCreate,
  rowUpdate,
];

import { createHash } from "node:crypto";
import {
  AuthExpired,
  type Connector,
  type ConnectorAction,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Todoist (CONNECTORS.md #7). Verified 2026-10-07: unified API v1 at
 * https://api.todoist.com/api/v1 (REST v2 returns 410 since 2026-02-10), Bearer token.
 * POST /sync (form-encoded): sync_token "*" = full sync, resource_types JSON array; writes are
 * commands (item_add, item_close) whose uuid is executed once, so a retry with the same uuid is
 * harmless. IDs are opaque strings.
 */

const API = "https://api.todoist.com/api/v1";

export const TodoistConfigSchema = z.object({
  /** Project names to keep; empty = all projects. */
  projects: z.array(z.string().min(1).max(200)).max(50).default([]),
});
export type TodoistConfig = z.infer<typeof TodoistConfigSchema>;
export interface TodoistCursor {
  syncToken: string;
  /** Project id → name (incremental syncs only return changed projects). */
  projects: Record<string, string>;
}

interface TItem {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  due: { date: string; datetime?: string | null; string?: string; is_recurring?: boolean } | null;
  checked: boolean;
  is_deleted: boolean;
  added_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  priority?: number;
  labels?: string[];
}
interface SyncResponse {
  sync_token: string;
  full_sync: boolean;
  items?: TItem[];
  projects?: { id: string; name: string; is_deleted?: boolean }[];
  user?: { full_name?: string; email?: string };
  sync_status?: Record<string, "ok" | { error: string; error_code?: number }>;
  temp_id_mapping?: Record<string, string>;
}

function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add a Todoist API token on the Connectors page.");
  return t;
}

/** POST /sync with form fields (JSON-encoded values for arrays). */
export async function sync(
  http: Http,
  tok: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<SyncResponse> {
  const res = await http.fetch(`${API}/sync`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403)
    throw new AuthExpired(
      "Todoist rejected the token. Copy it again from Settings → Integrations → Developer.",
    );
  if (!res.ok) throw new HttpError(res.status, `${API}/sync`, text);
  return JSON.parse(text) as SyncResponse;
}

export function itemToDocument(i: TItem, project: string | undefined): SourceDocument {
  const due = i.due?.datetime ?? i.due?.date;
  const at = Date.parse(i.updated_at ?? i.added_at ?? "") || Date.now();
  return {
    externalId: i.id,
    sourceType: "task",
    title: i.content,
    uri: `https://app.todoist.com/app/task/${i.id}`,
    createdAt: Date.parse(i.added_at ?? "") || at,
    updatedAt: at,
    mime: "text/markdown",
    body: {
      kind: "text",
      units: [
        {
          anchor: { kind: "row", rowId: i.id },
          heading: `Todoist task${project ? ` in ${project}` : ""}${due ? `, due ${i.due?.string ?? due}` : ""}${i.checked ? " (done)" : ""}`,
          text: `${i.content}\n\n${i.description ?? ""}`.trim(),
        },
      ],
    },
    meta: {
      state: i.checked ? "closed" : "open",
      ...(due ? { dueOn: due } : {}),
      ...(i.due?.is_recurring ? { recurring: true } : {}),
      project: project ?? null,
      labels: i.labels ?? [],
    },
  };
}

/** A UUID derived from the idempotency key: the same key always sends the same command uuid. */
export function commandUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Runs one command; throws Todoist's error if it was not applied. */
async function command(
  http: Http,
  tok: string,
  cmd: { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<SyncResponse> {
  const r = await sync(http, tok, { commands: JSON.stringify([cmd]) }, signal);
  const status = r.sync_status?.[cmd.uuid];
  if (status !== "ok")
    throw new Error(
      `Todoist: ${typeof status === "object" ? status.error : "command not applied"}`,
    );
  return r;
}

const TaskCreateSchema = z
  .object({
    content: z.string().trim().min(1).max(500),
    description: z.string().max(16_000).default(""),
    /** Project by name; empty = Inbox. */
    project: z.string().max(200).optional(),
    /** Natural language ("tomorrow 5pm") or a date (2026-10-20). */
    due: z.string().max(200).optional(),
  })
  .strict();
type TaskCreate = z.infer<typeof TaskCreateSchema>;
const TaskCloseSchema = z.object({ id: z.string().min(1).max(100) }).strict();
type TaskClose = z.infer<typeof TaskCloseSchema>;

const taskCreate: ConnectorAction<TaskCreate> = {
  type: "todoist.taskCreate",
  title: "Add Todoist task",
  schema: TaskCreateSchema,
  risk: "low",
  describe: (p) => ({
    target: `Todoist ${p.project ?? "Inbox"}`,
    summary: `New task "${p.content}"${p.due ? `, due ${p.due}` : ""}`,
    diff: p,
  }),
  async execute(p, ctx) {
    const tok = token(ctx.secrets);
    let projectId: string | undefined;
    if (p.project) {
      const r = await sync(ctx.http, tok, {
        sync_token: "*",
        resource_types: JSON.stringify(["projects"]),
      });
      projectId = r.projects?.find(
        (x) => !x.is_deleted && x.name.toLowerCase() === p.project?.toLowerCase(),
      )?.id;
      if (!projectId) throw new Error(`No Todoist project named "${p.project}"`);
    }
    const uuid = commandUuid(ctx.idempotencyKey);
    const r = await command(
      ctx.http,
      tok,
      {
        type: "item_add",
        uuid,
        temp_id: `t-${uuid}`,
        args: {
          content: p.content,
          ...(p.description ? { description: p.description } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          ...(p.due
            ? { due: /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? { date: p.due } : { string: p.due } }
            : {}),
        },
      },
      ctx.signal,
    );
    const id = r.temp_id_mapping?.[`t-${uuid}`] ?? null;
    return { taskId: id, url: id ? `https://app.todoist.com/app/task/${id}` : null };
  },
};

const taskClose: ConnectorAction<TaskClose> = {
  type: "todoist.taskClose",
  title: "Complete Todoist task",
  schema: TaskCloseSchema,
  risk: "low",
  describe: (p) => ({ target: "Todoist", summary: `Mark task ${p.id} as done` }),
  async execute(p, ctx) {
    await command(
      ctx.http,
      token(ctx.secrets),
      { type: "item_close", uuid: commandUuid(ctx.idempotencyKey), args: { id: p.id } },
      ctx.signal,
    );
    return { taskId: p.id, closed: true };
  },
};

export const todoist: Connector<TodoistConfig, TodoistCursor> = {
  id: "todoist",
  tier: "experimental",
  egress: () => ["api.todoist.com"],
  displayName: "Todoist",
  permissions: "Reads tasks and projects; adds and completes tasks after approval",
  configSchema: TodoistConfigSchema,
  secrets: [
    {
      name: "token",
      label: "API token",
      description: "Todoist → Settings → Integrations → Developer → copy the API token.",
    },
  ],
  defaultIntervalMin: 10,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const tok = token(ctx.secrets);
    const r = await sync(
      ctx.http,
      tok,
      {
        sync_token: cursor?.syncToken ?? "*",
        resource_types: JSON.stringify(["items", "projects"]),
      },
      ctx.signal,
    );
    const projects = { ...(r.full_sync ? {} : (cursor?.projects ?? {})) };
    for (const p of r.projects ?? []) {
      if (p.is_deleted) delete projects[p.id];
      else projects[p.id] = p.name;
    }
    const wanted = ctx.config.projects.map((s) => s.toLowerCase());
    const keep = (i: TItem) =>
      !wanted.length || wanted.includes((projects[i.project_id] ?? "").toLowerCase());
    const documents: SourceDocument[] = [];
    const deleted: string[] = [];
    for (const i of r.items ?? []) {
      if (i.is_deleted || !keep(i)) deleted.push(i.id);
      else documents.push(itemToDocument(i, projects[i.project_id]));
    }
    yield {
      documents,
      ...(deleted.length ? { deletedExternalIds: deleted } : {}),
      // No presence list: a full sync returns only active tasks, and completed ones stay in
      // memory as history. Deletions arrive as is_deleted on incremental syncs.
      ...(r.full_sync && cursor !== undefined ? { fullResync: true } : {}),
      cursor: { syncToken: r.sync_token, projects },
    };
  },
  async health(ctx) {
    const r = await sync(ctx.http, token(ctx.secrets), {
      sync_token: "*",
      resource_types: JSON.stringify(["user"]),
    });
    const who = r.user?.full_name ?? r.user?.email ?? "Todoist";
    return { status: "ok", message: `Signed in as ${who}`, account: who };
  },
  actions: () => [taskCreate, taskClose],
};

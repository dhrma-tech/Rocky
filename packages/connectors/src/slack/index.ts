import {
  type AnchorUnit,
  AuthExpired,
  type Connector,
  type ConnectorAction,
  type Http,
  HttpError,
  type SourceDocument,
} from "@rocky/connector-sdk";
import { z } from "zod";

/**
 * Slack (CONNECTORS.md #8). An internal app in the user's own workspace with a bot token
 * (xoxb-): channels:history, groups:history, channels:read, groups:read, users:read.
 * Verified 2026-10-07: conversations.history (oldest, cursor, limit ≤ 999); internal apps keep
 * Tier 3 (50+/min); the 1/min clamp is for apps distributed outside the Marketplace.
 * Polling, not Socket Mode (Phase 7 decision): one document per channel per day, rebuilt from
 * the start of its day on each sync. Drafts stay local: Rocky never posts to Slack.
 */

const API = "https://slack.com/api";
const DAY = 86_400_000;
/** Threads expanded per channel per sync (conversations.replies calls). */
const MAX_THREADS = 50;

export const SlackConfigSchema = z.object({
  /** Channel names (without #) or ids; empty = every channel the bot is a member of. */
  channels: z.array(z.string().min(1).max(100)).max(100).default([]),
  backfillDays: z.number().int().min(1).max(365).default(30),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
/** Per channel id: the newest message ts seen. */
export type SlackCursor = Record<string, string>;

interface SMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}
interface SChannel {
  id: string;
  name: string;
  is_member?: boolean;
  is_private?: boolean;
}

function token(secrets: { get(n: string): string | null }): string {
  const t = secrets.get("token");
  if (!t) throw new AuthExpired("Add the Slack bot token (xoxb-…) on the Connectors page.");
  return t;
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

/** A Web API GET; Slack reports errors as {ok: false, error} with HTTP 200. */
export async function slack<T>(
  http: Http,
  tok: string,
  method: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = `${API}/${method}?${new URLSearchParams(params)}`;
  const res = await http.fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  const body = JSON.parse(text) as { ok: boolean; error?: string } & T;
  if (!body.ok) {
    if (AUTH_ERRORS.has(body.error ?? ""))
      throw new AuthExpired(
        "Slack rejected the bot token. Reinstall the app and paste the new token.",
      );
    if (body.error === "missing_scope")
      throw new AuthExpired(
        "The Slack app is missing a scope. Add the scopes in the setup steps and reinstall.",
      );
    throw new Error(`Slack ${method}: ${body.error ?? "error"}`);
  }
  return body;
}

/** All pages of a cursor-paginated method. */
async function paged<T>(
  http: Http,
  tok: string,
  method: string,
  key: string,
  params: Record<string, string>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  do {
    const r = await slack<
      Record<string, unknown> & { response_metadata?: { next_cursor?: string } }
    >(http, tok, method, {
      ...params,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...((r[key] as T[] | undefined) ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return out;
}

/** Slack markup → plain text: mentions, channel links, URLs, entities. */
export function plainText(text: string, users: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${users.get(id) ?? id}`)
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const tsMs = (ts: string) => Math.round(Number(ts) * 1000);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStartTs = (ts: string) => String(Date.parse(`${utcDay(tsMs(ts))}T00:00:00Z`) / 1000);

export function permalink(teamUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = `${teamUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** One channel-day as a document: a unit per message, replies right after their parent. */
export function dayDocument(
  channel: SChannel,
  day: string,
  messages: SMessage[],
  replies: Map<string, SMessage[]>,
  users: Map<string, string>,
  teamUrl: string,
): SourceDocument {
  const name = (m: SMessage) => (m.user ? (users.get(m.user) ?? m.user) : (m.username ?? "bot"));
  const units: AnchorUnit[] = [];
  const urls: Record<string, string> = {};
  const add = (m: SMessage, reply: boolean) => {
    const time = new Date(tsMs(m.ts)).toISOString().slice(11, 16);
    units.push({
      anchor: { kind: "message", messageId: m.ts, threadId: channel.id },
      heading: `${reply ? "Reply from" : "From"} ${name(m)} at ${time} UTC`,
      text: plainText(m.text, users),
    });
    urls[m.ts] = permalink(teamUrl, channel.id, m.ts, m.thread_ts);
  };
  for (const m of [...messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
    add(m, false);
    for (const r of replies.get(m.ts) ?? []) if (r.ts !== m.ts) add(r, true);
  }
  const first = messages[0];
  const last = messages.at(-1);
  return {
    externalId: `${channel.id}:${day}`,
    sourceType: "chat",
    title: `#${channel.name} on ${day}`,
    uri: `${teamUrl.replace(/\/$/, "")}/archives/${channel.id}`,
    createdAt: first ? tsMs(first.ts) : Date.parse(day),
    updatedAt: last ? tsMs(last.ts) : Date.parse(day),
    mime: "text/plain",
    body: { kind: "text", units },
    meta: { channel: channel.id, channelName: channel.name, day, messageUrls: urls },
  };
}

const keep = (m: SMessage) =>
  m.type === "message" &&
  !["channel_join", "channel_leave", "channel_topic", "channel_purpose"].includes(
    m.subtype ?? "",
  ) &&
  m.text.trim() !== "";

const DraftSchema = z
  .object({
    /** Channel id (C…) or name. */
    channel: z.string().min(1).max(100),
    /** Reply in this thread (parent ts). */
    threadTs: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
type Draft = z.infer<typeof DraftSchema>;

/** Local only: approval marks the draft ready; the user copies it into Slack. Nothing is posted. */
const draftReply: ConnectorAction<Draft> = {
  type: "slack.draftReply",
  title: "Slack reply (draft, you post it)",
  schema: DraftSchema,
  risk: "low",
  describe: (p) => ({
    target: `Slack ${p.channel.startsWith("C") ? p.channel : `#${p.channel}`}`,
    summary: `${p.threadTs ? "Thread reply" : "Message"} ready to copy; Rocky does not post to Slack`,
    diff: { text: p.text },
  }),
  async execute(p) {
    const channel = p.channel.replace(/^#/, "");
    return {
      text: p.text,
      open: /^[CGD][A-Z0-9]+$/.test(channel)
        ? `https://slack.com/app_redirect?channel=${channel}`
        : null,
      threadTs: p.threadTs ?? null,
      posted: false,
    };
  },
};

export const slackConnector: Connector<SlackConfig, SlackCursor> = {
  id: "slack",
  tier: "experimental",
  egress: () => ["slack.com"],
  displayName: "Slack",
  permissions: "Reads channels the bot is in (recent history); drafts replies you post yourself",
  configSchema: SlackConfigSchema,
  secrets: [
    {
      name: "token",
      label: "bot token (xoxb-…)",
      description:
        "api.slack.com/apps → Create app → OAuth & Permissions → bot scopes channels:history, groups:history, channels:read, groups:read, users:read → Install → copy the Bot User OAuth Token. Then /invite the bot to the channels to remember.",
    },
  ],
  defaultIntervalMin: 5,
  readOnlyCapable: true,
  async *sync(ctx, cursor) {
    const tok = token(ctx.secrets);
    const auth = await slack<{ url: string }>(ctx.http, tok, "auth.test");
    const users = new Map(
      (
        await paged<{
          id: string;
          name: string;
          real_name?: string;
          profile?: { display_name?: string; real_name?: string };
        }>(ctx.http, tok, "users.list", "members", { limit: "200" })
      ).map((u) => [
        u.id,
        u.profile?.display_name || u.profile?.real_name || u.real_name || u.name,
      ]),
    );
    const all = await paged<SChannel>(ctx.http, tok, "conversations.list", "channels", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    const wanted = ctx.config.channels.map((c) => c.replace(/^#/, "").toLowerCase());
    const channels = all.filter((c) =>
      wanted.length
        ? wanted.includes(c.id.toLowerCase()) || wanted.includes(c.name.toLowerCase())
        : c.is_member,
    );
    const next: SlackCursor = { ...(cursor ?? {}) };
    const floor = String(
      Math.floor(Math.max(ctx.since, Date.now() - ctx.config.backfillDays * DAY) / 1000),
    );
    for (const ch of channels) {
      // From the start of the last seen day, so that day's document is rebuilt whole.
      const oldest = next[ch.id] ? dayStartTs(next[ch.id] as string) : floor;
      const messages = (
        await paged<SMessage>(ctx.http, tok, "conversations.history", "messages", {
          channel: ch.id,
          oldest,
          limit: "200",
        })
      ).filter(keep);
      if (!messages.length) continue;
      const replies = new Map<string, SMessage[]>();
      for (const m of messages.filter((x) => (x.reply_count ?? 0) > 0).slice(0, MAX_THREADS))
        replies.set(
          m.ts,
          (
            await paged<SMessage>(ctx.http, tok, "conversations.replies", "messages", {
              channel: ch.id,
              ts: m.ts,
              limit: "200",
            })
          ).filter(keep),
        );
      const byDay = new Map<string, SMessage[]>();
      for (const m of messages) {
        const d = utcDay(tsMs(m.ts));
        byDay.set(d, [...(byDay.get(d) ?? []), m]);
      }
      const documents = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, msgs]) => dayDocument(ch, day, msgs, replies, users, auth.url));
      const newest = messages.reduce(
        (a, m) => (Number(m.ts) > Number(a) ? m.ts : a),
        next[ch.id] ?? "0",
      );
      next[ch.id] = newest;
      yield { documents, cursor: { ...next } };
    }
    yield { documents: [], cursor: next };
  },
  async health(ctx) {
    const a = await slack<{ team: string; user: string }>(
      ctx.http,
      token(ctx.secrets),
      "auth.test",
    );
    return { status: "ok", message: `Connected to ${a.team} as ${a.user}`, account: a.team };
  },
  actions: () => [draftReply],
};

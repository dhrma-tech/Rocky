/**
 * Telegram (roadmap A3, D-066), checked against core.telegram.org/bots/api on 2026-10-21:
 * - requests: https://api.telegram.org/bot<token>/<method>, JSON body; answers
 *   {ok, result} or {ok: false, error_code, description}.
 * - getUpdates {offset, timeout, allowed_updates}: an update is confirmed once getUpdates is
 *   called with an offset higher than its update_id. It doesn't work while a webhook is set.
 * - sendMessage {chat_id, text (1–4096 characters), reply_markup, link_preview_options}.
 * - InlineKeyboardButton {text, url | callback_data (1–64 bytes)}.
 * - answerCallbackQuery {callback_query_id, text (0–200 characters)}.
 * Only the channel host holds the bot token. It hands the daemon the few fields it needs, and
 * only from allowed user IDs; a stranger's /start is reported by ID so the user can confirm it.
 */

export const TELEGRAM_API = "https://api.telegram.org";

/** What the daemon gets for one update: never the raw update, never a stranger's text. */
export type TelegramInbound =
  | { kind: "message"; fromId: number; chatId: number; text: string }
  | { kind: "callback"; fromId: number; chatId: number; callbackId: string; data: string }
  | { kind: "stranger"; fromId: number; name: string };

export interface TelegramButton {
  text: string;
  url?: string;
  /** At most 64 bytes (Telegram's limit). */
  data?: string;
}

export interface TelegramOutbound {
  chatId: number;
  text: string;
  buttons?: TelegramButton[];
}

interface RawUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface RawUpdate {
  update_id: number;
  message?: { from?: RawUser; chat: { id: number; type?: string }; text?: string };
  callback_query?: {
    id: string;
    from: RawUser;
    data?: string;
    message?: { chat: { id: number } };
  };
}

/** One raw update as what the daemon may see. Group chats are ignored: only private chats. */
export function toInbound(u: RawUpdate, allowed: readonly number[]): TelegramInbound | null {
  if (u.message?.from && typeof u.message.text === "string") {
    const { from, chat, text } = u.message;
    if (chat.type && chat.type !== "private") return null;
    if (!allowed.includes(from.id))
      return text.trim().startsWith("/start")
        ? { kind: "stranger", fromId: from.id, name: from.username ?? from.first_name ?? "" }
        : null;
    return { kind: "message", fromId: from.id, chatId: chat.id, text: text.slice(0, 4000) };
  }
  const q = u.callback_query;
  if (q?.data && q.message && allowed.includes(q.from.id))
    return {
      kind: "callback",
      fromId: q.from.id,
      chatId: q.message.chat.id,
      callbackId: q.id,
      data: q.data.slice(0, 64),
    };
  return null;
}

const TEXT_MAX = 4096;

/** The sendMessage body. Plain text (no parse_mode), so nothing in an answer is read as markup. */
export function sendMessageBody(m: TelegramOutbound): Record<string, unknown> {
  const text = m.text.length > TEXT_MAX ? `${m.text.slice(0, TEXT_MAX - 1)}…` : m.text;
  const buttons = (m.buttons ?? []).filter(
    (b) => b.url || (b.data && new TextEncoder().encode(b.data).length <= 64),
  );
  return {
    chat_id: m.chatId,
    text: text || "…",
    link_preview_options: { is_disabled: true },
    ...(buttons.length
      ? {
          reply_markup: {
            inline_keyboard: [
              buttons.map((b) =>
                b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data },
              ),
            ],
          },
        }
      : {}),
  };
}

export class TelegramError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Calls one Bot API method. The token is part of the URL, so errors never include the URL. */
export async function telegramCall<T>(
  fetch: typeof globalThis.fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };
  if (!json.ok)
    throw new TelegramError(
      json.error_code ?? res.status,
      json.description ?? `Telegram ${method} failed`,
    );
  return json.result as T;
}

/**
 * Long polling in the channel host. Each `tick` asks for new updates (waiting up to `timeoutS`
 * for one), hands allowed ones on, and moves the offset past them so they are confirmed.
 */
export class TelegramPoller {
  private offset = 0;
  private readonly fetch: typeof globalThis.fetch;
  private readonly token: () => string | null;
  private readonly allowed: () => readonly number[];
  private readonly onInbound: (m: TelegramInbound) => void;
  private readonly timeoutS: number;

  constructor(opts: {
    fetch: typeof globalThis.fetch;
    token: () => string | null;
    allowed: () => readonly number[];
    onInbound: (m: TelegramInbound) => void;
    timeoutS?: number;
  }) {
    this.fetch = opts.fetch;
    this.token = opts.token;
    this.allowed = opts.allowed;
    this.onInbound = opts.onInbound;
    this.timeoutS = opts.timeoutS ?? 30;
  }

  /** Updates seen, or null when there is nothing to poll (Telegram off or no token). */
  async tick(signal?: AbortSignal): Promise<number | null> {
    const token = this.token();
    if (!token) return null;
    const updates = await telegramCall<RawUpdate[]>(
      this.fetch,
      token,
      "getUpdates",
      {
        offset: this.offset,
        timeout: this.timeoutS,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
    );
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = toInbound(u, this.allowed());
      if (m) this.onInbound(m);
    }
    return updates.length;
  }
}

/** callback_data for an in-chat approval: action id and the start of its payload hash. */
export function approveData(actionId: string, payloadHash: string): string {
  return `ap:${actionId}:${payloadHash.slice(0, 16)}`;
}

export function parseApproveData(data: string): { actionId: string; hashPrefix: string } | null {
  const m = /^ap:([0-9A-Z]{26}):([0-9a-f]{16})$/.exec(data);
  return m ? { actionId: m[1] as string, hashPrefix: m[2] as string } : null;
}

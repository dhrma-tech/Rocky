import { chatDocuments, utcLabel } from "./chat.ts";
import type { ArchiveFiles, ChatMessage, ParsedArchive } from "./types.ts";

/** data/tweets.js, older data/tweet.js, and split parts (tweets-part1.js). */
const TWEETS_FILE = /(?:^|\/)(?:data\/)?tweets?(?:-part\d+)?\.js$/i;
const ACCOUNT_FILE = /(?:^|\/)(?:data\/)?account\.js$/i;

/** Strips the `window.YTD.<name>.part0 = ` assignment wrapper and parses the JSON array. */
export function parseYtd(text: string): unknown[] {
  const start = text.indexOf("[");
  if (start < 0 || !/^\s*window\.YTD\.[\w.]+\s*=\s*\[/.test(text.slice(0, start + 1)))
    throw new Error("missing window.YTD wrapper");
  const parsed = JSON.parse(text.slice(start)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("not an array");
  return parsed;
}

export const isX = (paths: string[]) => paths.some((p) => TWEETS_FILE.test(p));

interface Tweet {
  id_str?: string;
  id?: string;
  full_text?: string;
  text?: string;
  created_at?: string;
  in_reply_to_screen_name?: string;
}

/** Your posts, one document per month, each tweet anchored by its id. */
export function parseX(archive: ArchiveFiles): ParsedArchive {
  const result: ParsedArchive = { format: "x", documents: [], messages: 0, warnings: [] };
  const decoder = new TextDecoder();
  let handle = "you";
  for (const [p, bytes] of archive.files) {
    if (!ACCOUNT_FILE.test(p)) continue;
    try {
      const [first] = parseYtd(decoder.decode(bytes)) as { account?: { username?: string } }[];
      if (first?.account?.username) handle = `@${first.account.username}`;
    } catch {
      result.warnings.push(`${p}: unreadable account file`);
    }
  }
  const messages: ChatMessage[] = [];
  for (const [p, bytes] of archive.files) {
    if (!TWEETS_FILE.test(p)) continue;
    let rows: unknown[];
    try {
      rows = parseYtd(decoder.decode(bytes));
    } catch (err) {
      result.warnings.push(`${p}: ${(err as Error).message}, skipped`);
      continue;
    }
    for (const row of rows) {
      const t = ((row as { tweet?: Tweet }).tweet ?? row) as Tweet;
      const id = t.id_str ?? t.id;
      const ts = Date.parse(t.created_at ?? "");
      const text = t.full_text ?? t.text ?? "";
      if (!id || Number.isNaN(ts) || !text) continue;
      const reply = t.in_reply_to_screen_name ? ` (reply to @${t.in_reply_to_screen_name})` : "";
      messages.push({ id, ts, author: `${handle}${reply}`, text, ...utcLabel(ts) });
    }
  }
  result.messages = messages.length;
  result.documents = chatDocuments({
    format: "x",
    archive: archive.name,
    conversationId: handle.replace(/^@/, "").toLowerCase(),
    conversationName: `${handle} posts`,
    messages,
    uri: (m) => `https://x.com/i/web/status/${m.id}`,
  });
  return result;
}

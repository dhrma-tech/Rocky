import { chatDocuments, uniqueIds, utcLabel } from "./chat.ts";
import type { ArchiveFiles, ChatMessage, ParsedArchive } from "./types.ts";

const THREAD_FILE = /(?:^|\/)messages\/inbox\/([^/]+)\/message_\d+\.json$/i;

/**
 * Instagram writes UTF-8 bytes as one \u00XX escape per byte, so "é" arrives as "Ã©". Re-read
 * such strings as Latin-1 bytes; leave genuine wide characters alone.
 */
export function fixMojibake(s: string): string {
  const codes = [...s].map((ch) => ch.codePointAt(0) ?? 0);
  if (!codes.some((c) => c >= 0x80) || codes.some((c) => c > 0xff)) return s;
  const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

export const isInstagram = (paths: string[]) => paths.some((p) => THREAD_FILE.test(p));

interface IgMessage {
  sender_name?: string;
  timestamp_ms?: number;
  content?: string;
  share?: { link?: string; share_text?: string };
  photos?: unknown[];
  videos?: unknown[];
}

/** "Download your information" JSON: messages/inbox/<thread>/message_<n>.json, newest first. */
export function parseInstagram(archive: ArchiveFiles): ParsedArchive {
  const result: ParsedArchive = { format: "instagram", documents: [], messages: 0, warnings: [] };
  const threads = new Map<string, { title: string; messages: ChatMessage[] }>();
  for (const [p, bytes] of archive.files) {
    const m = THREAD_FILE.exec(p);
    if (!m) continue;
    const threadId = m[1] ?? "";
    let data: { title?: string; participants?: { name?: string }[]; messages?: IgMessage[] };
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      result.warnings.push(`${p}: invalid JSON, skipped`);
      continue;
    }
    const t = threads.get(threadId) ?? {
      title: fixMojibake(
        data.title ||
          (data.participants ?? []).map((x) => x.name ?? "").join(", ") ||
          threadId.replace(/_\d+$/, ""),
      ),
      messages: [],
    };
    for (const msg of data.messages ?? []) {
      const ts = msg.timestamp_ms;
      if (typeof ts !== "number") continue;
      const text = fixMojibake(
        msg.content ??
          (msg.share?.link ? `${msg.share.share_text ?? ""} ${msg.share.link}`.trim() : ""),
      );
      if (!text) continue;
      t.messages.push({
        id: `${threadId}@${ts}`,
        ts,
        author: fixMojibake(msg.sender_name ?? "unknown"),
        text,
        ...utcLabel(ts),
      });
    }
    threads.set(threadId, t);
  }
  for (const [threadId, t] of threads) {
    const messages = uniqueIds(t.messages.sort((a, b) => a.ts - b.ts));
    result.messages += messages.length;
    result.documents.push(
      ...chatDocuments({
        format: "instagram",
        archive: archive.name,
        conversationId: threadId,
        conversationName: t.title,
        messages,
      }),
    );
  }
  return result;
}

import { chatDocuments, utcLabel } from "./chat.ts";
import { csvRecords, parseCsv } from "./csv.ts";
import type { ArchiveFiles, ChatMessage, ParsedArchive } from "./types.ts";

/** `messages/c<id>/messages.json` (current) or `messages.csv` (older packages). */
const CHANNEL_FILE = /(?:^|\/)messages\/c?(\d+)\/(messages\.json|messages\.csv)$/i;

const json = (bytes: Uint8Array | undefined): unknown => {
  if (!bytes) return undefined;
  try {
    // Snowflake ids are written as bare numbers above 2^53; quote them before JSON.parse rounds them.
    const text = new TextDecoder()
      .decode(bytes)
      .replace(/^\ufeff/, "")
      .replace(/("(?:ID|id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** "2024-01-02 03:04:05[.ffffff][+00:00]" is UTC. */
function parseTime(s: string): number {
  const iso = s.trim().replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

const field = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "";
};

export const isDiscord = (paths: string[]) => paths.some((p) => CHANNEL_FILE.test(p));

/**
 * A Discord data package holds only your own messages, per channel. Channel names come from
 * `messages/index.json` (id → name), falling back to `channel.json`.
 */
export function parseDiscord(archive: ArchiveFiles): ParsedArchive {
  const result: ParsedArchive = { format: "discord", documents: [], messages: 0, warnings: [] };
  const paths = [...archive.files.keys()];
  const indexPath = paths.find((p) => /(?:^|\/)messages\/index\.json$/i.test(p));
  const index = (json(indexPath ? archive.files.get(indexPath) : undefined) ?? {}) as Record<
    string,
    string | null
  >;
  for (const p of paths) {
    const m = CHANNEL_FILE.exec(p);
    if (!m) continue;
    const channelId = m[1] ?? "";
    const dir = p.slice(0, p.lastIndexOf("/"));
    const channel = (json(archive.files.get(`${dir}/channel.json`)) ?? {}) as Record<
      string,
      unknown
    >;
    const guild = (channel.guild ?? {}) as Record<string, unknown>;
    const name =
      index[channelId] ||
      [field(channel, "name") && `#${field(channel, "name")}`, field(guild, "name")]
        .filter(Boolean)
        .join(" in ") ||
      `channel ${channelId}`;

    let rows: Record<string, unknown>[];
    const bytes = archive.files.get(p) ?? new Uint8Array();
    if (p.toLowerCase().endsWith(".json")) {
      const parsed = json(bytes);
      if (!Array.isArray(parsed)) {
        result.warnings.push(`${p}: not a JSON array, skipped`);
        continue;
      }
      rows = parsed as Record<string, unknown>[];
    } else rows = csvRecords(parseCsv(new TextDecoder().decode(bytes)));

    const messages: ChatMessage[] = [];
    for (const r of rows) {
      const id = field(r, "ID", "id");
      const ts = parseTime(field(r, "Timestamp", "TIMESTAMP", "timestamp"));
      const contents = field(r, "Contents", "CONTENTS", "contents");
      const attachments = field(r, "Attachments", "ATTACHMENTS", "attachments");
      const text = contents || (attachments ? "[attachment]" : "");
      if (!id || Number.isNaN(ts) || !text) continue;
      messages.push({ id, ts, author: "You", text, ...utcLabel(ts) });
    }
    result.messages += messages.length;
    const guildId = field(guild, "id");
    result.documents.push(
      ...chatDocuments({
        format: "discord",
        archive: archive.name,
        conversationId: channelId,
        conversationName: name,
        messages,
        uri: (msg) =>
          `https://discord.com/channels/${guildId || "@me"}/${channelId}/${msg.id.split("#")[0]}`,
      }),
    );
  }
  return result;
}

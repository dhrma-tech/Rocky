import { isDiscord, parseDiscord } from "./discord.ts";
import { isInstagram, parseInstagram } from "./instagram.ts";
import { isLinkedIn, parseLinkedIn } from "./linkedin.ts";
import {
  type ArchiveFiles,
  type ArchiveFormat,
  type ParsedArchive,
  UnrecognizedArchive,
} from "./types.ts";
import { looksLikeWhatsApp, parseWhatsApp } from "./whatsapp.ts";
import { isX, parseX } from "./x.ts";

export { chatDocuments, uniqueIds, utcLabel } from "./chat.ts";
export { csvRecords, parseCsv } from "./csv.ts";
export { filesFromZipStream, MAX_TEXT_BYTES, readArchive } from "./files.ts";
export { fixMojibake } from "./instagram.ts";
export * from "./types.ts";
export { chatNameFrom, parseWhatsAppChat } from "./whatsapp.ts";
export { parseYtd } from "./x.ts";

const PARSERS: Record<ArchiveFormat, (a: ArchiveFiles) => ParsedArchive> = {
  whatsapp: parseWhatsApp,
  discord: parseDiscord,
  instagram: parseInstagram,
  x: parseX,
  linkedin: parseLinkedIn,
};

/** Recognizes an export by its file layout; throws UnrecognizedArchive naming what it saw. */
export function detectArchive(archive: ArchiveFiles): ArchiveFormat {
  const paths = [...archive.files.keys()];
  if (isInstagram(paths)) return "instagram";
  if (isDiscord(paths)) return "discord";
  if (isX(paths)) return "x";
  if (isLinkedIn(archive)) return "linkedin";
  const decoder = new TextDecoder();
  for (const [p, b] of archive.files)
    if (/\.txt$/i.test(p) && looksLikeWhatsApp(decoder.decode(b.subarray(0, 4096))))
      return "whatsapp";
  const seen = paths.slice(0, 5).join(", ") || "no text files";
  throw new UnrecognizedArchive(
    `Not a recognized export (WhatsApp .txt/zip, Discord package, Instagram JSON, X archive, LinkedIn CSVs). Found: ${seen}${paths.length > 5 ? `, … (${paths.length} files)` : ""}`,
  );
}

/** Detects (or takes) the format and parses every conversation in the export. */
export function parseArchive(archive: ArchiveFiles, format?: ArchiveFormat): ParsedArchive {
  const f = format ?? detectArchive(archive);
  const parsed = PARSERS[f](archive);
  if (!parsed.documents.length)
    throw new UnrecognizedArchive(
      `No messages found in this ${f} export.${parsed.warnings.length ? ` ${parsed.warnings.join("; ")}` : ""}`,
    );
  return parsed;
}

/** The pseudo connector id imported documents are stored under (like local-files). */
export const importConnectorId = (format: ArchiveFormat) => `import:${format}`;

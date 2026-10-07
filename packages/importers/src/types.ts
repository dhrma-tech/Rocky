import type { SourceDocument } from "@rocky/connector-sdk";

export const ARCHIVE_FORMATS = ["whatsapp", "discord", "instagram", "x", "linkedin"] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

/** An export read into memory: forward-slash relative paths → bytes. Media files are left out. */
export interface ArchiveFiles {
  /** File or folder name of the export, without extension (WhatsApp takes the chat name from it). */
  name: string;
  files: Map<string, Uint8Array>;
}

export interface ParsedArchive {
  format: ArchiveFormat;
  documents: SourceDocument[];
  /** Messages kept in the documents. */
  messages: number;
  warnings: string[];
}

export class UnrecognizedArchive extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognizedArchive";
  }
}

/** One message, normalized across formats. */
export interface ChatMessage {
  /** Stable id within the conversation; becomes the citation anchor. */
  id: string;
  ts: number;
  author: string;
  text: string;
  /** Display time and month, from the export's own clock (WhatsApp has no time zone). */
  label: string;
  month: string;
}

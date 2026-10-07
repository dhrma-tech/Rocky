import { z } from "zod";

/** Archive importers (CONNECTORS.md "Archive importers"). */
export const ArchiveFormatSchema = z.enum(["whatsapp", "discord", "instagram", "x", "linkedin"]);
export type ArchiveFormatName = z.infer<typeof ArchiveFormatSchema>;

/** POST /imports/archive/path: an export already on this machine (CLI). */
export const ArchiveImportPathSchema = z
  .object({ path: z.string().min(1), format: ArchiveFormatSchema.optional() })
  .strict();
export type ArchiveImportPath = z.infer<typeof ArchiveImportPathSchema>;

export const ArchiveImportResultSchema = z.object({
  format: ArchiveFormatSchema,
  archive: z.string(),
  documents: z.number().int(),
  messages: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  skipped: z.number().int(),
  warnings: z.array(z.string()),
});
export type ArchiveImportResult = z.infer<typeof ArchiveImportResultSchema>;

/** GET /imports/archives: past imports, one row per format and export name. */
export const ArchiveImportRowSchema = z.object({
  format: ArchiveFormatSchema,
  archive: z.string(),
  documents: z.number().int(),
  messages: z.number().int(),
  importedAt: z.number().int(),
});
export type ArchiveImportRow = z.infer<typeof ArchiveImportRowSchema>;

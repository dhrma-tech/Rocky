import { z } from "zod";

/** User settings file: `<dataDir>/rocky.yaml`. Every field has a default, so an empty file is valid. */
export const AppConfigSchema = z.object({
  localOnly: z.boolean().default(false),
  budget: z.object({ monthlyCapUsd: z.number().nonnegative().default(10) }).prefault({}),
  ollama: z.object({ baseUrl: z.url().default("http://127.0.0.1:11434") }).prefault({}),
  whisper: z
    .object({
      model: z.enum(["base", "small"]).default("small"),
      /** "auto" detects the language; "en" is faster for English-only use. */
      language: z.enum(["auto", "en"]).default("auto"),
      /** CPU threads for whisper-cli; 0 means cores - 2. */
      threads: z.number().int().min(0).max(64).default(0),
    })
    .prefault({}),
  daemon: z.object({ port: z.number().int().min(1024).max(65535).default(7337) }).prefault({}),
  /**
   * Encrypt the store with SQLCipher (SECURITY.md "Data at rest"). The key lives in the keychain
   * as `db-key`. Turn it on for an existing store with `rocky db encrypt`, not by editing this.
   */
  storage: z.object({ encrypt: z.boolean().default(false) }).prefault({}),
  /**
   * MCP server (PLAN §4.10). An MCP client may be cloud-backed, so local-only documents and
   * notebooks are hidden from it, and with global localOnly every tool refuses, unless allowed here.
   */
  mcp: z.object({ allowLocalOnly: z.boolean().default(false) }).prefault({}),
  /** Connector plugins: npm package names or file: URLs (connectors.md "Plugins"). */
  plugins: z.array(z.string().min(1)).default([]),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** PUT /api/v1/settings: the user-editable subset. The data dir moves via `rocky`, not the API. */
export const SettingsUpdateSchema = z
  .object({
    localOnly: z.boolean(),
    budget: z.object({ monthlyCapUsd: z.number().nonnegative().max(10_000) }),
    ollama: z.object({ baseUrl: z.url() }),
  })
  .partial()
  .strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/** Bootstrap pointer: `%APPDATA%\Rocky\location.yaml`, lets the data dir live on another drive. */
export const LocationFileSchema = z.object({ dataDir: z.string().min(1) });

export const DataDirSourceSchema = z.enum(["flag", "env", "location-file", "default"]);
export type DataDirSource = z.infer<typeof DataDirSourceSchema>;

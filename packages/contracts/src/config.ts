import { z } from "zod";
import { NotificationPrefsSchema } from "./notifications.ts";

/** A DNS name, optionally with a port: "pc.tail1234.ts.net". Never an IP or a wildcard. */
export const HostNameSchema = z
  .string()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}(:|$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?(:\d{1,5})?$/,
    "a host name such as pc.tail1234.ts.net",
  );

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
  daemon: z
    .object({
      port: z.number().int().min(1024).max(65535).default(7337),
      /**
       * Names a phone may reach Rocky by, through a proxy that ends HTTPS on this computer
       * (`tailscale serve`, docs/PHONE.md). The daemon still listens on 127.0.0.1 only.
       */
      allowedHosts: z.array(HostNameSchema).max(10).default([]),
    })
    .prefault({}),
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
  /** Notifications (UI spec 16): which kinds reach which channel, and quiet hours. */
  notifications: NotificationPrefsSchema.prefault({}),
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
    notifications: NotificationPrefsSchema,
  })
  .partial()
  .strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

/** Bootstrap pointer: `%APPDATA%\Rocky\location.yaml`, lets the data dir live on another drive. */
export const LocationFileSchema = z.object({ dataDir: z.string().min(1) });

export const DataDirSourceSchema = z.enum(["flag", "env", "location-file", "default"]);
export type DataDirSource = z.infer<typeof DataDirSourceSchema>;

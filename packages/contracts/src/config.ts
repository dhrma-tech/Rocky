import { z } from "zod";

/** User settings file: `<dataDir>/rocky.yaml`. Every field has a default, so an empty file is valid. */
export const AppConfigSchema = z.object({
  localOnly: z.boolean().default(false),
  budget: z.object({ monthlyCapUsd: z.number().nonnegative().default(10) }).prefault({}),
  ollama: z.object({ baseUrl: z.url().default("http://127.0.0.1:11434") }).prefault({}),
  whisper: z.object({ model: z.enum(["base", "small"]).default("small") }).prefault({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Bootstrap pointer: `%APPDATA%\Rocky\location.yaml`, lets the data dir live on another drive. */
export const LocationFileSchema = z.object({ dataDir: z.string().min(1) });

export const DataDirSourceSchema = z.enum(["flag", "env", "location-file", "default"]);
export type DataDirSource = z.infer<typeof DataDirSourceSchema>;

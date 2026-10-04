import { z } from "zod";

export const CheckStatusSchema = z.enum(["pass", "warn", "fail"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const DoctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: CheckStatusSchema,
  detail: z.string(),
  hint: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const HardwareSchema = z.object({
  platform: z.string(),
  release: z.string(),
  cpu: z.string(),
  cores: z.number().int(),
  ramGb: z.number(),
  ramTier: z.enum(["low", "mid", "high"]),
  gpus: z.array(z.string()),
  cuda: z.boolean(),
});
export type Hardware = z.infer<typeof HardwareSchema>;

export const DoctorReportSchema = z.object({
  generatedAt: z.number().int(),
  dataDir: z.string(),
  dataDirSource: z.enum(["flag", "env", "location-file", "default"]),
  hardware: HardwareSchema,
  ollamaModels: z.array(z.string()),
  checks: z.array(DoctorCheckSchema),
  ok: z.boolean(),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

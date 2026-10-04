import { z } from "zod";
import { loadLayeredYaml } from "../config/load.ts";
import type { Db } from "../store/db.ts";

const PriceSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() });
export const PriceTableSchema = z.record(z.string(), PriceSchema);
export type PriceTable = z.infer<typeof PriceTableSchema>;

export const loadPrices = (dataDir: string): PriceTable =>
  PriceTableSchema.parse(loadLayeredYaml("prices", dataDir));

/** USD for a call, from per-million-token prices. */
export const costUsd = (
  price: z.infer<typeof PriceSchema>,
  inputTokens: number,
  outputTokens: number,
) => (price.input * inputTokens + price.output * outputTokens) / 1_000_000;

/** Deliberately conservative (~3 chars/token) so budget pre-checks over- rather than under-estimate. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

/** Start of the current UTC month, in ms. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function monthSpend(db: Db, now = Date.now()): number {
  const row = db
    .prepare("select coalesce(sum(cost_usd), 0) as s from usage_log where at >= ? and local = 0")
    .get(monthStart(now)) as { s: number };
  return row.s;
}

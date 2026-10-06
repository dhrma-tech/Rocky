import type { Rating } from "@rocky/contracts";

/**
 * SM-2, as published by SuperMemo (super-memory.com/english/ol/sm2.htm, checked 2026-10-06):
 * I(1)=1, I(2)=6, I(n)=I(n-1)*EF; EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02)), floor 1.3;
 * "If the quality response was lower than 3 then start repetitions for the item from the
 * beginning without changing the E-Factor". (Many libraries also change EF on a failure; the
 * original does not, and neither do we.)
 */

export const Q: Record<Rating, number> = { again: 1, hard: 3, good: 4, easy: 5 };
const DAY = 86_400_000;

export interface Sm2State {
  ef: number;
  intervalDays: number;
  repetitions: number;
}

export interface Sm2Result extends Sm2State {
  dueAt: number;
}

export function nextEf(ef: number, q: number): number {
  return Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
}

export function review(card: Sm2State, rating: Rating, now = Date.now()): Sm2Result {
  const q = Q[rating];
  if (q < 3) return { ef: card.ef, intervalDays: 1, repetitions: 0, dueAt: now + DAY };
  const ef = nextEf(card.ef, q);
  const repetitions = card.repetitions + 1;
  const intervalDays =
    repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(card.intervalDays * ef);
  return { ef, intervalDays, repetitions, dueAt: now + intervalDays * DAY };
}

export const NEW_CARD = { ef: 2.5, intervalDays: 0, repetitions: 0 } as const;

import type { Rating, ScheduleSlot, ScopeRules } from "@rocky/contracts";

/** Pure helpers for the Notebooks and Study screens (kept out of the components so they are testable). */

const DAY = 86_400_000;

/** Whole calendar days from `now` to `at` in local time (0 = today, negative = past). */
export function daysUntil(at: number, now = Date.now()): number {
  const start = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.round((start(at) - start(now)) / DAY);
}

export function daysLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** "CS201, Linear algebra ,, x" → ["CS201", "Linear algebra"]; entries under 2 characters are dropped. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const s = raw.trim();
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Drive and Notion links or bare ids → ids. Accepts folder URLs
 * (drive.google.com/drive/folders/<id>) and Notion page URLs (…-<32 hex>).
 */
export function parseIds(text: string, kind: "drive" | "notion"): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    let id = s;
    if (kind === "drive") {
      const m = s.match(/\/folders\/([\w-]+)/) ?? s.match(/[?&]id=([\w-]+)/);
      if (m?.[1]) id = m[1];
    } else {
      const m = s.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i);
      if (m?.[1]) {
        const h = m[1].toLowerCase();
        id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Drops empty arrays and missing dates, so an untouched editor saves `{}`. */
export function cleanRules(r: ScopeRules): ScopeRules {
  const out: ScopeRules = {};
  for (const k of [
    "connectorIds",
    "driveFolderIds",
    "notionPageIds",
    "sourceTypes",
    "titleMatches",
  ] as const) {
    const v = r[k];
    if (v && v.length > 0) (out as Record<string, unknown>)[k] = v;
  }
  if (typeof r.dateFrom === "number") out.dateFrom = r.dateFrom;
  if (typeof r.dateTo === "number") out.dateTo = r.dateTo;
  return out;
}

export function hasRules(r: ScopeRules): boolean {
  return Object.keys(cleanRules(r)).length > 0;
}

/** One line per rule, for the notebook header. */
export function rulesSummary(r: ScopeRules): string[] {
  const out: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (r.titleMatches?.length) out.push(`Titles containing ${r.titleMatches.join(", ")}`);
  if (r.driveFolderIds?.length)
    out.push(n(r.driveFolderIds.length, "Drive folder", "Drive folders"));
  if (r.notionPageIds?.length) out.push(n(r.notionPageIds.length, "Notion page", "Notion pages"));
  if (r.connectorIds?.length) out.push(n(r.connectorIds.length, "connector", "connectors"));
  if (r.sourceTypes?.length) out.push(`Types: ${r.sourceTypes.join(", ")}`);
  const d = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
  if (r.dateFrom && r.dateTo) out.push(`${d(r.dateFrom)} to ${d(r.dateTo)}`);
  else if (r.dateFrom) out.push(`From ${d(r.dateFrom)}`);
  else if (r.dateTo) out.push(`Until ${d(r.dateTo)}`);
  return out;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function slotLabel(s: ScheduleSlot): string {
  return `${DAYS[s.day]} ${s.start}–${s.end}`;
}

/** Keyboard 1–4 and the four buttons, per the spec (Again, Hard, Good, Easy). */
export const RATINGS: { rating: Rating; label: string; key: string }[] = [
  { rating: "again", label: "Again", key: "1" },
  { rating: "hard", label: "Hard", key: "2" },
  { rating: "good", label: "Good", key: "3" },
  { rating: "easy", label: "Easy", key: "4" },
];

export function ratingForKey(key: string): Rating | null {
  return RATINGS.find((r) => r.key === key)?.rating ?? null;
}

export function weaknessWord(w: number): "weak" | "shaky" | "solid" {
  return w >= 0.6 ? "weak" : w >= 0.35 ? "shaky" : "solid";
}

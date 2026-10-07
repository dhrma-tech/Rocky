/** Schedule editor helpers: the time + weekdays the UI edits ↔ a five-field cron expression. */

export interface SimpleSchedule {
  /** "07:00" */
  time: string;
  /** 0 = Sunday … 6 = Saturday, sorted. */
  days: number[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekdays as cron: ranges where possible ("1-5"), "*" for every day. */
function daysField(days: number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 0 && x <= 6).sort((a, b) => a - b);
  if (d.length === 0 || d.length === 7) return "*";
  const parts: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && (d[j + 1] as number) === (d[j] as number) + 1) j++;
    parts.push(j - i >= 2 ? `${d[i]}-${d[j]}` : d.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

export function toCron(s: SimpleSchedule): string {
  const [h = "0", m = "0"] = s.time.split(":");
  return `${Number(m)} ${Number(h)} * * ${daysField(s.days)}`;
}

/** The simple form of a cron expression, or null when it doesn't fit (then the raw field is shown). */
export function fromCron(expr: string): SimpleSchedule | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || mon !== "*") return null;
  const days = new Set<number>();
  if (dow === "*") for (let i = 0; i < 7; i++) days.add(i);
  else
    for (const part of dow.split(",")) {
      const r = /^(\d)(?:-(\d))?$/.exec(part);
      if (!r) return null;
      const a = Number(r[1]) % 7;
      const b = r[2] === undefined ? a : Number(r[2]) % 7;
      if (a > b) return null;
      for (let i = a; i <= b; i++) days.add(i);
    }
  return {
    time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`,
    days: [...days].sort((x, y) => x - y),
  };
}

export function scheduleLabel(expr: string): string {
  const s = fromCron(expr);
  if (!s) return expr;
  const d = s.days.join(",");
  const when =
    s.days.length === 7
      ? "Every day"
      : d === "1,2,3,4,5"
        ? "Weekdays"
        : d === "0,6"
          ? "Weekends"
          : s.days.map((x) => DAY_NAMES[x]).join(", ");
  return `${when} at ${s.time}`;
}

export const DAYS = DAY_NAMES;

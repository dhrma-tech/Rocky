/**
 * Minimal iCalendar (RFC 5545) reading and writing for CalDAV events: line unfolding, text
 * escapes, DTSTART/DTEND as UTC, floating, TZID-zoned or all-day dates. Recurrence rules are
 * kept as text (the first occurrence is the event's date); expanding them is a follow-up.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** ISO UTC timestamp, or "YYYY-MM-DD" for all-day events. */
  start: string;
  end: string | null;
  allDay: boolean;
  attendees: string[];
  organizer: string | null;
  rrule: string | null;
  status: string | null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins folded lines (CRLF followed by a space or tab). */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter(Boolean);
}

function parseLine(line: string): Prop | null {
  // The value starts after the first colon that is not inside a quoted parameter.
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name = "", ...rawParams] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

export const unescapeText = (s: string) =>
  s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
export const escapeText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Offset of `tz` from UTC at instant `ms`, in ms (Intl; no time-zone database needed). */
function tzOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

/** Wall-clock time in `tz` → UTC ms (two passes for DST edges). Unknown zones fall back to UTC. */
export function zonedToUtc(
  fields: [number, number, number, number, number, number],
  tz: string,
): number {
  const [y, mo, d, h, mi, s] = fields;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    let utc = wall - tzOffset(wall, tz);
    utc = wall - tzOffset(utc, tz);
    return utc;
  } catch {
    return wall;
  }
}

/** A DATE or DATE-TIME property → ISO UTC string, or YYYY-MM-DD for dates. */
export function parseIcsDate(p: Prop): { value: string; allDay: boolean } | null {
  const v = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || p.params.VALUE === "DATE") {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null;
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return null;
  const f = t.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = t[7]
    ? Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5])
    : p.params.TZID
      ? zonedToUtc(f, p.params.TZID)
      : new Date(f[0], f[1] - 1, f[2], f[3], f[4], f[5]).getTime(); // floating: this machine's time
  return { value: new Date(ms).toISOString(), allDay: false };
}

/** The master VEVENT of a calendar object (overrides with RECURRENCE-ID are skipped). */
export function parseEvent(ics: string): IcsEvent | null {
  let depth: string[] = [];
  let props: Prop[] | null = null;
  let master: Prop[] | null = null;
  for (const line of unfold(ics)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      depth = [...depth, p.value.toUpperCase()];
      if (p.value.toUpperCase() === "VEVENT" && depth.length === 2) props = [];
      continue;
    }
    if (p.name === "END") {
      if (p.value.toUpperCase() === "VEVENT" && props) {
        if (!props.some((x) => x.name === "RECURRENCE-ID") && !master) master = props;
        props = null;
      }
      depth = depth.slice(0, -1);
      continue;
    }
    if (props && depth.at(-1) === "VEVENT") props.push(p);
  }
  if (!master) return null;
  const get = (n: string) => master?.find((x) => x.name === n);
  const startProp = get("DTSTART");
  const start = startProp ? parseIcsDate(startProp) : null;
  const uid = get("UID")?.value;
  if (!start || !uid) return null;
  const endProp = get("DTEND");
  const end = endProp ? parseIcsDate(endProp) : null;
  const mail = (v: string) =>
    v
      .replace(/^mailto:/i, "")
      .trim()
      .toLowerCase();
  return {
    uid,
    summary: unescapeText(get("SUMMARY")?.value ?? ""),
    description: unescapeText(get("DESCRIPTION")?.value ?? ""),
    location: unescapeText(get("LOCATION")?.value ?? ""),
    start: start.value,
    end: end?.value ?? null,
    allDay: start.allDay,
    attendees: master
      .filter((x) => x.name === "ATTENDEE")
      .map((x) => mail(x.value))
      .filter((e) => e.includes("@")),
    organizer: get("ORGANIZER") ? mail(get("ORGANIZER")?.value ?? "") : null,
    rrule: get("RRULE")?.value ?? null,
    status: get("STATUS")?.value ?? null,
  };
}

const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Folds a content line at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** A single VEVENT as an iCalendar object. Times are written in UTC; dates as VALUE=DATE. */
export function buildEvent(e: {
  uid: string;
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  start: { dateTime?: string | undefined; date?: string | undefined };
  end: { dateTime?: string | undefined; date?: string | undefined };
  now: number;
}): string {
  const when = (name: string, w: { dateTime?: string | undefined; date?: string | undefined }) =>
    w.date
      ? `${name};VALUE=DATE:${w.date.replace(/-/g, "")}`
      : `${name}:${utcStamp(Date.parse(w.dateTime ?? ""))}`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rocky//Rocky//EN",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${utcStamp(e.now)}`,
    when("DTSTART", e.start),
    when("DTEND", e.end),
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .map(fold)
    .join("\r\n");
}

// Schedule parsing and next-run math (spec §16.2). Cron is evaluated in an IANA zone via Intl.
const MIN = 60_000;

export type Schedule =
  | { kind: "cron"; source: string; minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }
  | { kind: "interval"; source: string; everyMs: number };

export class ScheduleError extends Error {}

const PRESETS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, lo: number, hi: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const isDow = hi === 6;
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`bad step in "${text}"`);
    const num = (s: string) => {
      const i = names?.indexOf(s.toLowerCase()) ?? -1;
      const n = i >= 0 ? i + nameBase : Number(s);
      if (!Number.isInteger(n)) throw new ScheduleError(`bad value "${s}"`);
      return n;
    };
    let a = lo, b = isDow ? 6 : hi;
    if (range !== "*") {
      const [x, y] = range.split("-");
      a = num(x);
      b = y === undefined ? (stepText === undefined ? a : hi) : num(y);
    }
    const max = isDow ? 7 : hi; // day of week: 7 = Sunday
    if (a < lo || b > max || a > b) throw new ScheduleError(`value out of range in "${text}"`);
    for (let n = a; n <= b; n += step) out.add(isDow && n === 7 ? 0 : n);
  }
  return out;
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const TIME_RE = "(noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)";

/** "9am", "9:30pm", "18:30", "noon", "9" to [hour, minute]; null when it is not a time of day. */
function clock(text: string): [number, number] | null {
  const t = text.trim().toLowerCase().replace(/\./g, "");
  if (t === "noon") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return [h, min];
}

const NATURAL_HELP =
  'Use a preset (hourly, daily, weekly, monthly), a 5-field cron, "every N minutes|hours|days", or a phrase such as ' +
  '"every weekday at 9am", "daily at 18:30", "every monday", "every weekend at 10am", "monthly on the 1st at 8am"';

/**
 * Small deterministic parser for common phrases (spec 16.2 "natural language"). Returns a 5-field cron string,
 * null when the text is not a schedule phrase at all, and throws ScheduleError when it is one but the time is bad.
 * No time given means 09:00. Supported: `every weekday|weekend|day|<day>[, <day> and <day>]`, `daily`, `weekdays`,
 * `weekends`, `monthly|every month on the <N>th`, each with an optional `at <time>` (also in front).
 */
export function naturalToCron(input: string): string | null {
  let t = input.trim().toLowerCase().replace(/[.,;!]+$/, "").replace(/\s+/g, " ");
  let time: [number, number] | null = null;
  const bad = () => new ScheduleError(`"${input.trim()}" has a time of day that is not valid`);
  const lead = new RegExp(`^at ${TIME_RE} (.+)$`).exec(t);
  const tail = new RegExp(`^(.+?) (?:at )?${TIME_RE}$`).exec(t);
  if (lead) { time = clock(lead[1]!); if (!time) throw bad(); t = lead[2]!; }
  else if (tail && (clock(tail[2]!) || /\bat\b/.test(t))) {
    time = clock(tail[2]!);
    if (!time) throw bad();
    t = tail[1]!.replace(/ at$/, "");
  }
  if (t === "every hour" || t === "hourly") return time ? null : "0 * * * *";
  const [h, min] = time ?? [9, 0];
  const when = `${min} ${h}`;
  if (/^(every day|daily|every night|nightly|each day)$/.test(t)) return `${when} * * *`;
  if (/^(every weekday|weekdays|every week day|on weekdays|each weekday)$/.test(t)) return `${when} * * 1-5`;
  if (/^(every weekend|weekends|on weekends|each weekend)$/.test(t)) return `${when} * * 0,6`;
  const month = /^(?:monthly|every month|each month)(?: on)?(?: the)? ?(\d{1,2})?(?:st|nd|rd|th)?$/.exec(t) ?? /^on the (\d{1,2})(?:st|nd|rd|th)?(?: of)? (?:every|each) month$/.exec(t);
  if (month) {
    const d = month[1] === undefined ? 1 : Number(month[1]);
    if (d < 1 || d > 31) throw new ScheduleError(`day of month ${d} is out of range`);
    return `${when} ${d} * *`;
  }
  const days = /^(?:every|on|each) ([a-z]+(?:s)?(?:(?:, | and |, and | & )[a-z]+s?)*)$/.exec(t);
  if (days) {
    const set = new Set<number>();
    for (const w of days[1]!.split(/, and |, | and | & /)) {
      const d = DAY_NAMES[w] ?? DAY_NAMES[w.replace(/s$/, "")];
      if (d === undefined) return null;
      set.add(d);
    }
    return `${when} * * ${[...set].sort((a, b) => a - b).join(",")}`;
  }
  return null;
}

/** Parses a preset, a 5-field cron, an interval ("every 30m", "every 2h", "every 1d") or a natural phrase. */
export function parseSchedule(input: string): Schedule {
  const text = input.trim();
  if (!text) throw new ScheduleError("empty schedule");
  const iv = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(text);
  if (iv) {
    const n = Number(iv[1]);
    const unit = iv[2][0].toLowerCase();
    const everyMs = n * (unit === "m" ? MIN : unit === "h" ? 60 * MIN : 24 * 60 * MIN);
    if (n < 1 || everyMs < MIN) throw new ScheduleError("interval must be at least 1 minute");
    return { kind: "interval", source: text, everyMs };
  }
  let expr = PRESETS[text.toLowerCase()];
  if (!expr) {
    const tokens = text.split(/\s+/);
    const cronLike = tokens.length === 5 && tokens.every((x) => /^[0-9*?\/,-]+$|^[a-z]{3}([,-][a-z]{3})*$/i.test(x));
    expr = cronLike ? text : naturalToCron(text) ?? "";
    if (!expr) throw new ScheduleError(`Cannot understand schedule "${text}". ${NATURAL_HELP}.`);
  }
  const f = expr.split(/\s+/);
  if (f.length !== 5) throw new ScheduleError(`expected 5 cron fields, a preset or "every N<m|h|d>", got "${text}"`);
  return {
    kind: "cron", source: text,
    minute: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31),
    month: field(f[3], 1, 12, MONTHS, 1), dow: field(f[4], 0, 6, DAYS, 0),
    domStar: f[2] === "*", dowStar: f[4] === "*",
  };
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
export const machineTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Offset of `tz` from UTC in ms at instant `t`. */
export function zoneOffsetMs(tz: string, t: number): number {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const whole = Math.floor(t / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

function cronMatches(s: Extract<Schedule, { kind: "cron" }>, d: Date): boolean {
  if (!s.minute.has(d.getUTCMinutes()) || !s.hour.has(d.getUTCHours()) || !s.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = s.dom.has(d.getUTCDate()), dowOk = s.dow.has(d.getUTCDay());
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk; // both set: either matches
}

/**
 * First scheduled instant strictly after `after` (ms), or undefined within 366 days.
 * Intervals count from `anchor` (the automation's creation time).
 */
export function nextRun(s: Schedule, after: number, tz: string, anchor = 0): number | undefined {
  if (s.kind === "interval") {
    if (after < anchor) return anchor + s.everyMs;
    return anchor + (Math.floor((after - anchor) / s.everyMs) + 1) * s.everyMs;
  }
  const limit = after + 366 * 24 * 60 * MIN;
  let t = (Math.floor(after / MIN) + 1) * MIN;
  let off = 0, offAt = -Infinity;
  for (; t <= limit; t += MIN) {
    if (t - offAt >= 15 * MIN) { off = zoneOffsetMs(tz, t); offAt = t; } // offsets change on 15-minute boundaries
    if (cronMatches(s, new Date(t + off))) return t;
  }
  return undefined;
}

/** Scheduled instants in (after, upTo], capped. */
export function slotsBetween(s: Schedule, after: number, upTo: number, tz: string, anchor = 0, cap = 1000): number[] {
  const out: number[] = [];
  let t = after;
  while (out.length < cap) {
    const n = nextRun(s, t, tz, anchor);
    if (n === undefined || n > upTo) break;
    out.push(n);
    t = n;
  }
  return out;
}

/**
 * Save-time normalisation (spec 16.2): a natural phrase becomes its cron once, so the stored schedule is exact and
 * never re-interpreted. Presets, cron and intervals are kept as written. Throws ScheduleError for anything else.
 */
export function normalizeSchedule(input: string): string {
  const s = parseSchedule(input);
  if (s.kind === "cron" && naturalToCron(input.trim()) !== null && !PRESETS[input.trim().toLowerCase()]) {
    return naturalToCron(input.trim())!;
  }
  return input.trim();
}

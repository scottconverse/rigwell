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

/** Parses a preset, a 5-field cron, or an interval ("every 30m", "every 2h", "every 1d"). */
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
  const expr = PRESETS[text.toLowerCase()] ?? text;
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

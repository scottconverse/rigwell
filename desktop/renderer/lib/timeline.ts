// Time dividers for the transcript. Pure, so the day and gap rules can be tested without a screen.
import type { TranscriptRow } from "./activity.ts";

export type TimelineRow = TranscriptRow | { kind: "divider"; id: string; label: string };

/** A divider shows after this much quiet time, or when the calendar day changes. */
export const DIVIDER_GAP_MS = 30 * 60 * 1000;

const dayStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const dayDiff = (a: number, b: number) => Math.round((dayStart(a) - dayStart(b)) / 86_400_000);

/** "Today 2:14 PM", "Yesterday 2:14 PM", "Nov 3 2:14 PM", or "Nov 3, 2025 2:14 PM" for another year. */
export function timeLabel(at: number, now: number, locale?: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  const days = dayDiff(now, at);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.toLocaleDateString(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} ${time}`;
}

const timesOf = (r: TranscriptRow) => (r.kind === "group" ? r.items : [r.item]).flatMap((i) => (i.at === undefined ? [] : [i.at]));

/** Adds a divider before a row when time passed since the last row with a time. Rows with no time never get one. */
export function withDividers(rows: TranscriptRow[], now: number, locale?: string): TimelineRow[] {
  const out: TimelineRow[] = [];
  let last: number | undefined;
  for (const r of rows) {
    const times = timesOf(r);
    const first = times[0];
    if (first !== undefined && last !== undefined && (first - last >= DIVIDER_GAP_MS || dayStart(first) !== dayStart(last))) {
      out.push({ kind: "divider", id: `divider-${r.kind === "group" ? r.id : r.item.id}`, label: timeLabel(first, now, locale) });
    }
    if (times.length) last = times[times.length - 1];
    out.push(r);
  }
  return out;
}

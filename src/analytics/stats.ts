export const GAP_MS = 30 * 60_000;
export interface StatSession { times: number[]; firstAt: number }
export interface LocalStats { sessions: number; activeMs: number; longestMs: number; weekendSessions: number }
export interface Badge { name: string; rule: string; line: string; earned: boolean; progress: string }
/** Stretches: sort the times; a gap over GAP_MS starts a new stretch. A stretch's length is its last time minus its first. */
export function localStats(list: StatSession[], isWeekend: (ms: number) => boolean): LocalStats {
  let activeMs = 0, longestMs = 0, weekendSessions = 0;
  for (const session of list) {
    if (isWeekend(session.firstAt)) weekendSessions++;
    const times = [...session.times].sort((a, b) => a - b);
    if (!times.length) continue;
    let start = times[0]!, end = times[0]!;
    const close = () => { const length = end - start; activeMs += length; if (length > longestMs) longestMs = length; };
    for (const time of times.slice(1)) {
      if (time - end > GAP_MS) { close(); start = time; }
      end = time;
    }
    close();
  }
  return { sessions: list.length, activeMs, longestMs, weekendSessions };
}
export function badges(s: LocalStats): Badge[] {
  const hoursProgress = `${(Math.floor(s.activeMs / 360000) / 10).toFixed(1)} of 5 hours`;
  const pct = s.sessions === 0 ? 0 : Math.floor((s.weekendSessions / s.sessions) * 100);
  return [
    { name: "First Steps", rule: "100+ sessions", line: "One hundred sessions behind you.", earned: s.sessions >= 100, progress: s.sessions >= 100 ? "Earned" : `${s.sessions} of 100 sessions` },
    { name: "Regular", rule: "5+ hours total", line: "Five hours of steady work.", earned: s.activeMs >= 5 * 3_600_000, progress: s.activeMs >= 5 * 3_600_000 ? "Earned" : hoursProgress },
    { name: "Long Haul", rule: "1+ hour session", line: "A full hour without a break.", earned: s.longestMs >= 3_600_000, progress: s.longestMs >= 3_600_000 ? "Earned" : `Longest ${Math.floor(s.longestMs / 60000)} of 60 minutes` },
    { name: "Weekend Builder", rule: "30%+ sessions on weekends", line: "Some of your best work happens on days off.", earned: s.sessions > 0 && s.weekendSessions / s.sessions >= 0.3, progress: s.sessions > 0 && s.weekendSessions / s.sessions >= 0.3 ? "Earned" : `${pct}% of sessions on weekends` },
  ];
}
export const localWeekend = (ms: number) => { const d = new Date(ms).getDay(); return d === 0 || d === 6; };

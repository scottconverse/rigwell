// Browser pane tab list helpers (spec §17.3): move, next/previous and the reopen stack. Pure functions.
export function moveTab<T extends { key: string }>(tabs: T[], key: string, dir: -1 | 1): T[] {
  const i = tabs.findIndex((t) => t.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tabs.length) return tabs;
  const out = tabs.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The tab key after stepping `dir` from `current`, wrapping around. */
export function stepTab(keys: string[], current: string, dir: -1 | 1): string {
  if (!keys.length) return "";
  const i = keys.indexOf(current);
  return keys[(i + dir + keys.length) % keys.length];
}

/** Remembers closed tab URLs, newest last; about:blank is not worth reopening. */
export function pushClosed(stack: string[], url: string, max = 10): string[] {
  if (!url || url === "about:blank") return stack;
  return [...stack, url].slice(-max);
}

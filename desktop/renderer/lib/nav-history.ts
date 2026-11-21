// Back and Forward for the hash routes. Pure, so it can be tested without a window.
export interface NavHistory { entries: string[]; index: number }

const LIMIT = 200;

export const startHistory = (route: string): NavHistory => ({ entries: [route], index: 0 });
export const canGoBack = (h: NavHistory) => h.index > 0;
export const canGoForward = (h: NavHistory) => h.index < h.entries.length - 1;

/** Records a new page. A visit after Back removes the old Forward entries. The current page again changes nothing. */
export function visit(h: NavHistory, route: string): NavHistory {
  if (h.entries[h.index] === route) return h;
  const entries = [...h.entries.slice(0, h.index + 1), route].slice(-LIMIT);
  return { entries, index: entries.length - 1 };
}

export const stepBack = (h: NavHistory): NavHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h);
export const stepForward = (h: NavHistory): NavHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h);
export const currentRoute = (h: NavHistory) => h.entries[h.index];

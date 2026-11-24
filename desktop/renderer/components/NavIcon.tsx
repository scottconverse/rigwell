/** Paths drawn on a 24 by 24 grid. */
export const ICONS24 = {
  plus: "M12 5v14M5 12h14",
  sync: "M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 4v5h-5M4 20v-5h5",
  search: "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4-4",
  more: "M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
  flag: "M6 4v16M6 5h11l-2 4 2 4H6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  panel: "M4 5h16v14H4zM15 5v14",
};

/** A small line icon. Hidden from screen readers, so the button keeps its text name. */
export function NavIcon({ d, grid = 16, size = 14 }: { d: string; grid?: number; size?: number }) {
  return <svg className="nav-icon" viewBox={`0 0 ${grid} ${grid}`} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={grid === 24 ? 2 : 1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

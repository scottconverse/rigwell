// Per-window zoom (spec 14.4, 19.4): each window has a slot (0, 1, 2...) and its zoom level is kept in
// <home>/window-zoom.json as { "<slot>": level }. A new window takes the lowest free slot, so the first window always
// comes back at the zoom it was closed with. No Electron imports: unit tested on its own.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MIN_ZOOM = -3;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 0.5;

export const zoomFile = (home: string) => join(home, "window-zoom.json");

export const clampZoom = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(v * 2) / 2)) : 0;
};

export function loadZoom(home: string): Record<string, number> {
  try {
    const j = JSON.parse(readFileSync(zoomFile(home), "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    return Object.fromEntries(Object.entries(j).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "number").map(([k, v]) => [k, clampZoom(v)]));
  } catch { return {}; }
}

export function saveZoom(home: string, slot: number, level: number): Record<string, number> {
  const all = loadZoom(home);
  const lvl = clampZoom(level);
  all[String(slot)] = lvl; // 0 is kept: a window reset to 100% must not fall back to the app-wide level
  const p = zoomFile(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, p);
  return all;
}

/** The lowest slot not used by an open window. */
export function freeSlot(used: Iterable<number>): number {
  const u = new Set(used);
  let i = 0;
  while (u.has(i)) i++;
  return i;
}

/** The level for a slot: its saved one, else the app-wide `windowZoomLevel` setting. */
export function zoomFor(home: string, slot: number, fallback: number): number {
  const all = loadZoom(home);
  return String(slot) in all ? all[String(slot)] : clampZoom(fallback);
}

export const stepZoom = (level: number, dir: 1 | -1 | 0): number => (dir === 0 ? 0 : clampZoom(level + dir * ZOOM_STEP));

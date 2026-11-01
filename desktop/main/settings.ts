// Desktop settings file (spec §14.4): separate from the agent settings. Lives at <home>/desktop-settings.json.
// Read synchronously, before the first window exists, so appearance can be applied before first paint (§19.4).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ThemePref = "system" | "light" | "dark";
export type SoundValue = "off" | "bell" | "ok" | "ack" | { file: string };

export interface AppearanceSettings {
  theme: ThemePref;
  /** Background used for the window before the page paints, per resolved theme (spec §19.4 defaults). */
  startupBackground: { dark: string; light: string };
  accent?: string;
  /** Named color token overrides per theme (the importable and exportable theme format). */
  tokens?: { dark?: Record<string, string>; light?: Record<string, string> };
  contrast: "normal" | "high";
  uiFont: string;
  contentFont: string;
  codeFont: string;
  uiFontSize: number;
  contentFontSize: number;
  codeFontSize: number;
  diffView: { mode: "unified" | "split"; wrap: boolean; markers: boolean };
  reduceMotion: boolean;
}

export interface SoundSettings {
  completionSound: SoundValue;
  awaitingInputSound: SoundValue;
  soundVolume: number;
  soundFocusMode: "always" | "focused" | "unfocused";
  subagentSounds: "off" | "quiet";
}

export interface DesktopSettings {
  keepAwakeEnabled: boolean;
  desktopAutoUpdateEnabled: boolean;
  locale: string;
  windowZoomLevel: number;
  automationQuitWarningDismissed: boolean;
  autoOpenFilePreviews: boolean;
  appearance: AppearanceSettings;
  /** Desktop alerts: the two categories of spec §19.2. */
  notifications: { finished: boolean; needsInput: boolean };
  sounds: SoundSettings;
  /** Shortcuts that can be switched off by id. */
  disabledShortcuts: string[];
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
}

export const DEFAULT_STARTUP_BACKGROUND = { dark: "#161413", light: "#f2f0f0" };

export const DEFAULT_SETTINGS: DesktopSettings = {
  keepAwakeEnabled: false,
  desktopAutoUpdateEnabled: true,
  locale: "en",
  windowZoomLevel: 0,
  automationQuitWarningDismissed: false,
  autoOpenFilePreviews: true,
  appearance: {
    theme: "system",
    startupBackground: { ...DEFAULT_STARTUP_BACKGROUND },
    contrast: "normal",
    uiFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    contentFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    codeFont: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    uiFontSize: 14, contentFontSize: 15, codeFontSize: 13,
    diffView: { mode: "unified", wrap: false, markers: true },
    reduceMotion: false,
  },
  notifications: { finished: true, needsInput: true },
  sounds: { completionSound: "off", awaitingInputSound: "ack", soundVolume: 100, soundFocusMode: "always", subagentSounds: "off" },
  disabledShortcuts: [],
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep merge of plain objects; arrays and scalars from `over` win. Unknown keys are kept. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge((base as any)[k], v) : v;
  return out as T;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Fixes values that would break the UI (bad colors, out-of-range numbers) and falls back to defaults. */
export function sanitize(s: DesktopSettings): DesktopSettings {
  const a = s.appearance;
  if (!["system", "light", "dark"].includes(a.theme)) a.theme = "system";
  for (const k of ["dark", "light"] as const) if (!HEX.test(a.startupBackground[k])) a.startupBackground[k] = DEFAULT_STARTUP_BACKGROUND[k];
  s.sounds.soundVolume = Math.min(100, Math.max(0, Math.round(Number(s.sounds.soundVolume) || 0)));
  if (!["always", "focused", "unfocused"].includes(s.sounds.soundFocusMode)) s.sounds.soundFocusMode = "always";
  if (!["off", "quiet"].includes(s.sounds.subagentSounds)) s.sounds.subagentSounds = "off";
  return s;
}

export const settingsPath = (home: string) => join(home, "desktop-settings.json");

export function loadDesktopSettings(home: string): DesktopSettings {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(settingsPath(home), "utf8")); } catch { raw = undefined; }
  return sanitize(merge(structuredClone(DEFAULT_SETTINGS), raw));
}

export function saveDesktopSettings(home: string, s: DesktopSettings) {
  const p = settingsPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, p);
}

/** Applies a partial update (deep merge), sanitizes and saves. */
export function updateDesktopSettings(home: string, patch: unknown): DesktopSettings {
  const next = sanitize(merge(loadDesktopSettings(home), patch));
  saveDesktopSettings(home, next);
  return next;
}

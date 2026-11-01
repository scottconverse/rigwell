// Appearance before first paint (spec §19.4). Pure functions: given the saved settings and whether the OS is dark,
// they produce everything the main process needs to create the window already in the right colors, and the values the
// page's boot script applies before React loads. No flash in either direction because
//   1. the BrowserWindow is created with backgroundColor = the resolved theme's startup background,
//   2. nativeTheme.themeSource is set before the window exists, so the OS title bar and scrollbars match,
//   3. boot.js (a blocking script in <head>) sets data-theme and the CSS variables before the body is parsed.
import type { AppearanceSettings, ThemePref } from "./settings.ts";

export type ResolvedTheme = "light" | "dark";

export const resolveTheme = (pref: ThemePref, systemDark: boolean): ResolvedTheme => (pref === "system" ? (systemDark ? "dark" : "light") : pref);

/** Foreground for the title-bar overlay buttons on a given background (simple luminance check). */
export function readableOn(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1a1a1a" : "#f2f2f2";
}

export interface InitialWindow {
  resolved: ResolvedTheme;
  /** Value for nativeTheme.themeSource (same as the preference). */
  themeSource: ThemePref;
  backgroundColor: string;
  /** Hidden title bar with the native overlay on Windows and Linux (spec §14.2); macOS uses inset traffic lights. */
  titleBar: { titleBarStyle: "hidden"; titleBarOverlay?: { color: string; symbolColor: string; height: number }; trafficLightPosition?: { x: number; y: number } };
  /** Passed to the preload as a process argument so the boot script needs no IPC round trip. */
  boot: BootValues;
}

export interface BootValues {
  theme: ThemePref;
  resolved: ResolvedTheme;
  bg: string;
  /** CSS custom properties to set on :root before paint. */
  vars: Record<string, string>;
  reduceMotion: boolean;
  contrast: "normal" | "high";
}

export function bootValues(a: AppearanceSettings, systemDark: boolean): BootValues {
  const resolved = resolveTheme(a.theme, systemDark);
  const bg = a.startupBackground[resolved];
  const vars: Record<string, string> = {
    "--rw-bg-startup": bg,
    "--rw-font-ui": a.uiFont, "--rw-font-content": a.contentFont, "--rw-font-code": a.codeFont,
    "--rw-size-ui": `${a.uiFontSize}px`, "--rw-size-content": `${a.contentFontSize}px`, "--rw-size-code": `${a.codeFontSize}px`,
  };
  if (a.accent) vars["--rw-accent"] = a.accent;
  for (const [k, v] of Object.entries(a.tokens?.[resolved] ?? {})) if (/^[a-z][a-z0-9-]*$/i.test(k) && typeof v === "string") vars[`--rw-${k}`] = v;
  return { theme: a.theme, resolved, bg, vars, reduceMotion: a.reduceMotion, contrast: a.contrast };
}

export function initialWindowOptions(a: AppearanceSettings, systemDark: boolean, platform: NodeJS.Platform): InitialWindow {
  const boot = bootValues(a, systemDark);
  const titleBar: InitialWindow["titleBar"] = { titleBarStyle: "hidden" };
  if (platform === "darwin") titleBar.trafficLightPosition = { x: 14, y: 14 };
  else titleBar.titleBarOverlay = { color: boot.bg, symbolColor: readableOn(boot.bg), height: 36 };
  return { resolved: boot.resolved, themeSource: a.theme, backgroundColor: boot.bg, titleBar, boot };
}

/** Title-bar overlay colors to apply when the theme changes at runtime. */
export function overlayFor(a: AppearanceSettings, systemDark: boolean) {
  const bg = a.startupBackground[resolveTheme(a.theme, systemDark)];
  return { color: bg, symbolColor: readableOn(bg), height: 36 };
}

/**
 * What the boot script does with the values, as a pure function so it can be tested: given the values from the preload
 * (or, when missing, the last stored preference) and the OS preference, the attributes and variables to set on <html>.
 */
export function applyBoot(boot: BootValues | undefined, stored: string | null, systemDark: boolean): { attrs: Record<string, string>; vars: Record<string, string>; background: string } {
  const pref: ThemePref = boot?.theme ?? (stored === "light" || stored === "dark" || stored === "system" ? stored : "system");
  const resolved = boot?.resolved ?? resolveTheme(pref, systemDark);
  const attrs: Record<string, string> = { "data-theme": resolved, "data-theme-pref": pref };
  if (boot?.reduceMotion) attrs["data-reduce-motion"] = "true";
  if (boot?.contrast === "high") attrs["data-contrast"] = "high";
  return { attrs, vars: boot?.vars ?? {}, background: boot?.bg ?? (resolved === "dark" ? "#161413" : "#f2f0f0") };
}

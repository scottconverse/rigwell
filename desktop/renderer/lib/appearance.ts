// Applies appearance settings to the live page. Uses the same pure helpers as the boot script, so the first paint and
// later changes agree. Switching theme only flips attributes and CSS variables: no reload, no flash.
import type { AppearanceSettings } from "../../main/settings.ts";
import { applyBoot, bootValues } from "../../main/appearance.ts";

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

let applied: string[] = [];

export function applyAppearance(a: AppearanceSettings) {
  const root = document.documentElement;
  const boot = bootValues(a, prefersDark());
  const r = applyBoot(boot, null, prefersDark());
  for (const k of ["data-reduce-motion", "data-contrast"]) root.removeAttribute(k);
  for (const [k, v] of Object.entries(r.attrs)) root.setAttribute(k, v);
  for (const k of applied) root.style.removeProperty(k);
  applied = Object.keys(r.vars);
  for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v);
  root.style.backgroundColor = r.background;
  try { localStorage.setItem("rigwell.theme", a.theme); } catch {}
}

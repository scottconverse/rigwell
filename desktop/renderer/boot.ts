// Runs as a blocking script in <head>, before the body is parsed and before React loads (spec §19.4). The main process
// already created the window with the right background; this sets the matching attributes and CSS variables so the first
// painted frame is themed. The decision logic is the pure applyBoot() from main/appearance.ts.
import { applyBoot, type BootValues } from "../main/appearance.ts";

const w = window as unknown as { rigwell?: { boot?: BootValues } };
let stored: string | null = null;
try { stored = localStorage.getItem("rigwell.theme"); } catch {}
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const r = applyBoot(w.rigwell?.boot, stored, dark);
const root = document.documentElement;
for (const [k, v] of Object.entries(r.attrs)) root.setAttribute(k, v);
for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v);
root.style.backgroundColor = r.background;
root.style.colorScheme = r.attrs["data-theme"];
// Evidence for tests and diagnostics: what the page looked like on the first frame.
requestAnimationFrame(() => { (window as unknown as { __firstFrame?: unknown }).__firstFrame = { theme: root.getAttribute("data-theme"), bg: getComputedStyle(root).backgroundColor }; });

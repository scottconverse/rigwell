// Hook configuration loading (spec §5.6 "Config").
// Per level folder: `hooks.json` (legacy `hooks/hooks.json`) replaces the `hooks` key of settings.json /
// settings.local.json per event key. Across levels (folder > project > user) the lists are CONCATENATED
// (highest priority first, so config order = priority order). hooksDisabled / showHookOutput: first level that sets them.
import path from "node:path";
import { configDirs, readJsonObject } from "../config/levels.ts";

export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit", "Stop",
  "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  type: "command";
  command: string;
  /** Seconds. Default 60. */
  timeout?: number;
  preserveRiskLevel?: boolean;
}
export interface HookGroup {
  matcher?: string;
  commandRegex?: string;
  hooks: HookCommand[];
  /** Settings level the group came from (informational). */
  level?: string;
}
export interface HooksConfig {
  hooksDisabled: boolean;
  showHookOutput: boolean;
  events: Partial<Record<HookEventName, HookGroup[]>>;
  warnings: string[];
}

export const DEFAULT_HOOK_TIMEOUT_S = 60;
const isEvent = (k: string): k is HookEventName => (HOOK_EVENTS as readonly string[]).includes(k);

/** Validate one event's group list; invalid entries are dropped. */
export function normalizeGroups(raw: unknown, level?: string): HookGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: HookGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object" || !Array.isArray((g as any).hooks)) continue;
    const hooks: HookCommand[] = [];
    for (const h of (g as any).hooks) {
      if (!h || typeof h !== "object" || typeof h.command !== "string" || !h.command.trim()) continue;
      if (h.type !== undefined && h.type !== "command") continue;
      const hc: HookCommand = { type: "command", command: h.command };
      if (typeof h.timeout === "number" && h.timeout > 0) hc.timeout = h.timeout;
      if (h.preserveRiskLevel === true) hc.preserveRiskLevel = true;
      hooks.push(hc);
    }
    if (!hooks.length) continue;
    const grp: HookGroup = { hooks, level };
    if (typeof (g as any).matcher === "string") grp.matcher = (g as any).matcher;
    if (typeof (g as any).commandRegex === "string") grp.commandRegex = (g as any).commandRegex;
    out.push(grp);
  }
  return out;
}

interface RawHooks { events: Record<string, unknown>; hooksDisabled?: boolean; showHookOutput?: boolean }

function pick(obj: Record<string, unknown> | null): RawHooks {
  const r: RawHooks = { events: {} };
  if (!obj) return r;
  for (const [k, v] of Object.entries(obj)) if (isEvent(k)) r.events[k] = v;
  if (typeof obj.hooksDisabled === "boolean") r.hooksDisabled = obj.hooksDisabled;
  if (typeof obj.showHookOutput === "boolean") r.showHookOutput = obj.showHookOutput;
  return r;
}

export interface LoadHooksOptions {
  cwd: string;
  /** Test override for the home dir used by the "no project" check. */
  homeDir?: string;
  /** false = skip project and folder levels (folder not trusted yet, spec §5.6 Skips). Default true. */
  trustProject?: boolean;
  /** Extra hooks injected at the top priority (e.g. runtime settings file). Same shape as hooks.json. */
  extra?: Record<string, unknown>;
  /** Org flag: drop every non-org hook. The org slot is a no-op in this build, so this yields no hooks. */
  allowManagedHooksOnly?: boolean;
}

export function loadHooksConfig(opts: LoadHooksOptions): HooksConfig {
  const warnings: string[] = [];
  const cfg: HooksConfig = { hooksDisabled: false, showHookOutput: true, events: {}, warnings };
  if (opts.allowManagedHooksOnly) return cfg;
  let setDisabled = false, setShow = false;
  const take = (r: RawHooks) => {
    if (!setDisabled && r.hooksDisabled !== undefined) { cfg.hooksDisabled = r.hooksDisabled; setDisabled = true; }
    if (!setShow && r.showHookOutput !== undefined) { cfg.showHookOutput = r.showHookOutput; setShow = true; }
  };
  const add = (r: RawHooks, level: string) => {
    for (const [ev, raw] of Object.entries(r.events)) {
      const groups = normalizeGroups(raw, level);
      if (!groups.length) continue;
      (cfg.events[ev as HookEventName] ??= []).push(...groups);
    }
  };
  if (opts.extra) { const r = pick(opts.extra); take(r); add(r, "runtime"); }

  for (const { level, dir } of configDirs(opts.cwd, opts.homeDir)) {
    if (level !== "user" && opts.trustProject === false) continue;
    const merged: RawHooks = { events: {} };
    // settings.json then settings.local.json (local wins per event key), `hooks` key
    for (const name of ["settings.json", "settings.local.json"]) {
      const f = readJsonObject(path.join(dir, name));
      if (f.warning) warnings.push(f.warning);
      const h = f.value?.hooks;
      if (h && typeof h === "object" && !Array.isArray(h)) {
        const r = pick(h as Record<string, unknown>);
        Object.assign(merged.events, r.events);
        if (r.hooksDisabled !== undefined) merged.hooksDisabled = r.hooksDisabled;
        if (r.showHookOutput !== undefined) merged.showHookOutput = r.showHookOutput;
      }
      if (typeof f.value?.hooksDisabled === "boolean") merged.hooksDisabled = f.value.hooksDisabled as boolean;
      if (typeof f.value?.showHookOutput === "boolean") merged.showHookOutput = f.value.showHookOutput as boolean;
    }
    // hooks.json (or legacy hooks/hooks.json) replaces per event key
    for (const file of [path.join(dir, "hooks.json"), path.join(dir, "hooks", "hooks.json")]) {
      const f = readJsonObject(file);
      if (f.warning) warnings.push(f.warning);
      if (!f.value) continue;
      const src = f.value.hooks && typeof f.value.hooks === "object" && !Array.isArray(f.value.hooks)
        ? { ...(f.value.hooks as object), ...pickFlags(f.value) } : f.value;
      const r = pick(src as Record<string, unknown>);
      Object.assign(merged.events, r.events);
      if (r.hooksDisabled !== undefined) merged.hooksDisabled = r.hooksDisabled;
      if (r.showHookOutput !== undefined) merged.showHookOutput = r.showHookOutput;
      break;
    }
    take(merged);
    add(merged, level);
  }
  return cfg;
}

function pickFlags(o: Record<string, unknown>) {
  const r: Record<string, unknown> = {};
  if ("hooksDisabled" in o) r.hooksDisabled = o.hooksDisabled;
  if ("showHookOutput" in o) r.showHookOutput = o.showHookOutput;
  return r;
}

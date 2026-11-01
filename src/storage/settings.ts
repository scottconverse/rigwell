// Layered settings loader (spec §12.2).
// Precedence, highest -> lowest: org (no-op slot) > runtime (--settings) > folder (nearer wins)
// > project > user > builtin. Within a level `settings.local.json` wins over `settings.json`.
// Merge: plain objects deep-merge; arrays and scalars REPLACE (command lists included: the
// higher level's list is the whole list; no concatenation).
// Project/folder config is always loaded (no trustedFolders gate) in Phase 1.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AutonomyLevel, InteractionMode, ReasoningEffort } from "../core/types.ts";
import { rigwellHome, userHomeDir } from "./paths.ts";

export interface CustomModelEntry {
  model?: string;
  displayName?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  extraArgs?: Record<string, unknown>;
  maxOutputTokens?: number;
  maxContextLimit?: number;
  reasoningEffort?: ReasoningEffort;
  noImageSupport?: boolean;
  [k: string]: unknown;
}

export interface RigwellSettings {
  sessionDefaultSettings?: {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    interactionMode?: InteractionMode;
    autonomyLevel?: AutonomyLevel;
    [k: string]: unknown;
  };
  commandAllowlist?: string[];
  commandDenylist?: string[];
  commandBlocklist?: string[];
  customModels?: CustomModelEntry[];
  compactionTokenLimit?: number;
  compactionThresholdCheckEnabled?: boolean;
  env?: Record<string, string>;
  trustedFolders?: Record<string, { trustedAt?: number | string }>;
  [k: string]: unknown;
}

export type SettingsLevel = "org" | "runtime" | "folder" | "project" | "user" | "builtin";
export interface SettingsSource {
  level: SettingsLevel;
  /** Absolute file path; empty for builtin. */
  path: string;
}

export interface LoadedSettings {
  settings: RigwellSettings;
  /** Files that contributed, highest priority first (builtin last). */
  sources: SettingsSource[];
  /** Unreadable/invalid files and similar non-fatal problems. */
  warnings: string[];
}

export const BUILTIN_SETTINGS: RigwellSettings = {
  sessionDefaultSettings: { reasoningEffort: "high", autonomyLevel: "off", interactionMode: "auto" },
};

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge `over` onto `base` (returns a new object). Arrays/scalars from `over` replace. */
export function mergeSettings<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const cur = out[k];
    out[k] = isPlain(v) && isPlain(cur) ? mergeSettings(cur, v) : isPlain(v) ? mergeSettings({}, v) : v;
  }
  return out as T;
}

function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readJsonFile(file: string, warnings: string[]): Record<string, unknown> | null {
  let text: string;
  try {
    if (!statSync(file).isFile()) return null;
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(text);
    if (isPlain(j)) return j;
    warnings.push(`${file}: not a JSON object, ignored`);
  } catch (e) {
    warnings.push(`${file}: invalid JSON (${(e as Error).message}), ignored`);
  }
  return null;
}

const contains = (outer: string, inner: string) => {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function loadSettings(opts: {
  cwd: string;
  runtimeSettingsPath?: string;
  /** Override for tests; defaults to $HOME. */
  homeDir?: string;
}): LoadedSettings {
  const warnings: string[] = [];
  const cwd = path.resolve(opts.cwd);
  const home = path.resolve(opts.homeDir ?? userHomeDir());
  const userDir = rigwellHome();

  const gitRoot = findGitRoot(cwd);
  const projectRoot = gitRoot ?? cwd;
  // "No project" when the root is the home dir or contains it.
  const hasProject = !contains(projectRoot, home);
  const projectDir = hasProject ? path.join(projectRoot, ".rigwell") : null;

  // Levels in ASCENDING priority; each is [level, dir-or-file list in ascending priority].
  type Layer = { level: SettingsLevel; file: string };
  const layers: Layer[] = [];
  const pair = (level: SettingsLevel, dir: string) => {
    layers.push({ level, file: path.join(dir, "settings.json") });
    layers.push({ level, file: path.join(dir, "settings.local.json") });
  };

  pair("user", userDir);
  if (projectDir) pair("project", projectDir);
  if (gitRoot) {
    // cwd up to (excluding) git root; farthest first so nearer wins.
    const chain: string[] = [];
    for (let d = cwd; d !== gitRoot && contains(gitRoot, d); d = path.dirname(d)) chain.push(d);
    for (const d of chain.reverse()) {
      const dir = path.join(d, ".rigwell");
      if (dir === projectDir || dir === userDir) continue;
      pair("folder", dir);
    }
  }
  if (opts.runtimeSettingsPath) layers.push({ level: "runtime", file: path.resolve(opts.runtimeSettingsPath) });
  // org: no-op slot (would be appended here).

  let settings: RigwellSettings = mergeSettings({}, BUILTIN_SETTINGS);
  const used: SettingsSource[] = [];
  for (const l of layers) {
    const j = readJsonFile(l.file, warnings);
    if (!j) {
      if (l.level === "runtime") warnings.push(`${l.file}: runtime settings file not found or unreadable`);
      continue;
    }
    settings = mergeSettings(settings, j);
    used.push({ level: l.level, path: l.file });
  }
  const sources = [...used.reverse(), { level: "builtin" as const, path: "" }];
  return { settings, sources, warnings };
}

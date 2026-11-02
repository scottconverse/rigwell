// Layered settings loader (spec §12.2).
// Precedence, highest -> lowest: org (no-op slot) > runtime (--settings) > folder (nearer wins)
// > project > user > builtin. Within a level `settings.local.json` wins over `settings.json`.
// Merge: plain objects deep-merge; arrays and scalars REPLACE (command lists included: the
// higher level's list is the whole list; no concatenation).
// Project/folder config is always loaded (no trustedFolders gate) in Phase 1.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutonomyLevel, InteractionMode, ReasoningEffort } from "../core/types.ts";
import type { SandboxSettings } from "../sandbox/policy.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";
import { applyOrg, loadOrgSettings } from "./org.ts";
import { rigwellHome, userHomeDir } from "./paths.ts";

export interface CustomModelEntry {
  model?: string;
  displayName?: string;
  provider?: string;
  baseUrl?: string;
  /** AWS settings (spec 12.2), checked in models.ts. */
  bedrock?: unknown;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  extraArgs?: Record<string, unknown>;
  maxOutputTokens?: number;
  maxContextLimit?: number;
  reasoningEffort?: ReasoningEffort;
  noImageSupport?: boolean;
  apiProvider?: string;
  chatCompletionRequest?: Record<string, unknown>;
  chatCompletionRequestByProvider?: Record<string, Record<string, unknown>>;
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
  /** OAuth provider entries a custom model can name in `credentialSource` (src/auth/config.ts, docs/auth.md). */
  oauthProviders?: Record<string, Record<string, unknown>>;
  /** Models (custom model id or API name) that run Script-only; all others run direct (spec §4.1). */
  scriptToolModels?: string[];
  /** Script limits: foregroundMs, sliceMs, totalMs, memoryBytes. */
  scriptLimits?: { foregroundMs?: number; sliceMs?: number; totalMs?: number; memoryBytes?: number };
  compactionTokenLimit?: number;
  /** Summarizer numbers: reserveTokens, targetTokens, textHeadroom, customModelCap, postCeilingTokens, keepRecentTurns, toolResultCapChars. */
  compaction?: Record<string, number>;
  /** Model id that writes compaction summaries (default: the session model). */
  compactionModel?: string;
  /** Milliseconds a response may take (hard limit) and the idle limit for custom models; default 10 minutes. */
  llmRequestTimeout?: number;
  /** Loop guard thresholds (spec 4.2): streamIdleTimeoutMs, hardResponseLimitMs, emptyTurnStop, repeatNudgeAt, repeatStopAt, cycleMinRepeats, cycleMinChars. */
  loopGuards?: Record<string, number>;
  /** Candidates for the "auto" model id: { classifierModel, candidates: [{ model, description, inputCost }], threshold?, timeoutMs? }. */
  autoRouter?: { classifierModel: string; candidates: { model: string; description: string; inputCost: number }[]; threshold?: number; timeoutMs?: number };
  compactionThresholdCheckEnabled?: boolean;
  /** "current-model": compaction summaries use the active model; "default" (or unset): `compactionModel` when set. */
  compactionModelMode?: "current-model" | "default";
  /** Scan staged changes before `git commit` for secrets (spec 12.2; Rigwell name for the secret-scan switch). */
  enableSecretScan?: boolean;
  /** Org only: the highest autonomy level any session may use. */
  maxAutonomyLevel?: AutonomyLevel;
  /** Org: allowedModelIds / blockedModelIds / allowCustomModels. */
  modelPolicy?: { allowedModelIds?: string[]; blockedModelIds?: string[]; allowCustomModels?: boolean };
  allowManagedHooksOnly?: boolean;
  /** Display (TUI): diffMode github|unified, todoDisplayMode pinned|inline, toolResultDisplay expanded|compact, outputStyle, showThinkingInMainView, streamAssistantResponses. */
  diffMode?: "github" | "unified";
  todoDisplayMode?: "pinned" | "inline";
  toolResultDisplay?: "expanded" | "compact";
  outputStyle?: string;
  showThinkingInMainView?: boolean;
  streamAssistantResponses?: boolean;
  /** Per-command Execute sandbox (spec 5.5.8). */
  sandbox?: SandboxSettings;
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
  /** Top-level keys the org level set (shown as "[managed by org]"). Empty when there is no org file. */
  managedKeys: string[];
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
  /** false: the folder is not trusted, so the project and folder levels are skipped (spec 12.2 trustedFolders). Default true. */
  trusted?: boolean;
  /** Override for tests; defaults to $HOME. */
  homeDir?: string;
  /** Environment holding RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH; defaults to process.env. */
  env?: Record<string, string | undefined>;
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
  if (projectDir && opts.trusted !== false) pair("project", projectDir);
  if (gitRoot && opts.trusted !== false) {
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
  // org: the highest level (spec 12.2), from the local file named by RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH.
  let managedKeys: string[] = [];
  const org = loadOrgSettings(opts.env ?? process.env);
  if (org) {
    warnings.push(...org.warnings);
    if (Object.keys(org.settings).length > 0) {
      const r = applyOrg(settings as Record<string, unknown>, org.settings, DEFAULT_COMMAND_LISTS, mergeSettings);
      settings = r.settings as RigwellSettings;
      managedKeys = r.managedKeys;
      used.push({ level: "org", path: org.path });
    }
  }
  const sources = [...used.reverse(), { level: "builtin" as const, path: "" }];
  return { settings, sources, warnings, managedKeys };
}

// ---------- trusted folders (spec 12.2) ----------

/**
 * Is `cwd` trusted? Rules, simplest safe first: RIGWELL_TRUST_CWD=1 (or `rigwell ... --trust`, which sets it) trusts the
 * working folder for this process; otherwise a folder is trusted when it, or a folder above it, is listed in the USER
 * settings `trustedFolders` (a project file can never trust itself).
 */
export function isFolderTrusted(cwd: string, trustedFolders: RigwellSettings["trustedFolders"], env: Record<string, string | undefined> = process.env): boolean {
  if (env.RIGWELL_TRUST_CWD === "1" || env.RIGWELL_TRUST_CWD === "true") return true;
  const abs = path.resolve(cwd);
  return Object.keys(trustedFolders ?? {}).some((k) => contains(path.resolve(k), abs));
}

/** True when the folder (or the repo around it) has project configuration that trust would unlock. */
export function hasProjectConfig(cwd: string): boolean {
  const top = findGitRoot(path.resolve(cwd)) ?? path.resolve(cwd);
  for (let d = path.resolve(cwd); contains(top, d); d = path.dirname(d)) {
    for (const n of [".rigwell", ".agents", ".agent", "AGENTS.md", "CLAUDE.md"]) if (existsSync(path.join(d, n))) return true;
    if (d === top) break;
  }
  return false;
}

/** Remembers a trusted folder in the user settings file. */
export function trustFolder(cwd: string): void {
  const file = path.join(rigwellHome(), "settings.json");
  let cur: Record<string, unknown> = {};
  try { const j = JSON.parse(readFileSync(file, "utf8")); if (isPlain(j)) cur = j; } catch { /* new file */ }
  const tf = isPlain(cur.trustedFolders) ? { ...cur.trustedFolders } : {};
  tf[path.resolve(cwd)] = { trustedAt: Date.now() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...cur, trustedFolders: tf }, null, 2) + "\n");
}

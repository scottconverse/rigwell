// Org-managed settings (spec 12.2): a real "org" level read from a local file named by the environment variable
// RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH. It is the highest level: every key it sets wins, and for the keys below a
// lower level can never loosen what the org set:
//   maxAutonomyLevel   a ceiling for autonomy (session defaults, update_session_settings, "always allow" options)
//   commandDenylist / commandBlocklist   unioned with every lower level (and with the defaults)
//   commandAllowlist   when the org sets it, it is the whole allowlist (lower levels cannot add entries)
//   modelPolicy        allowedModelIds / blockedModelIds / allowCustomModels; when the org sets it, lower levels' copy is dropped
//   sandbox            the stricter setting wins (see mergeSandboxOrg in src/sandbox/policy.ts)
//   hooks, allowManagedHooksOnly   org hooks always run; with allowManagedHooksOnly every other hook is dropped
// File shape: the settings object itself, or {"managedSettings": {...}} (the same shape a server cache would hold).
import { readFileSync, statSync } from "node:fs";
import type { AutonomyLevel } from "../core/types.ts";
import { mergeSandboxOrg, type SandboxSettings } from "../sandbox/policy.ts";

export interface ModelPolicy {
  allowedModelIds?: string[];
  blockedModelIds?: string[];
  /** false: BYOK models from user, project and folder settings are ignored (org customModels still load). */
  allowCustomModels?: boolean;
}

export interface OrgSettings {
  maxAutonomyLevel?: AutonomyLevel;
  commandAllowlist?: string[];
  commandDenylist?: string[];
  commandBlocklist?: string[];
  modelPolicy?: ModelPolicy;
  sandbox?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  allowManagedHooksOnly?: boolean;
  [k: string]: unknown;
}

export interface LoadedOrg {
  path: string;
  settings: OrgSettings;
  warnings: string[];
}

export const ORG_ENV = "RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH";
const MAX_BYTES = 1024 * 1024;
const RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** Reads the org file named by the environment. Returns null when the variable is unset or the file is unusable (warnings say why). */
export function loadOrgSettings(env: Record<string, string | undefined> = process.env): LoadedOrg | null {
  const file = env[ORG_ENV];
  if (!file) return null;
  const warnings: string[] = [];
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    if (st.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { path: file, settings: {}, warnings: [`${file}: org settings file unreadable (${(e as Error).message}), ignored`] };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    return { path: file, settings: {}, warnings: [`${file}: invalid JSON (${(e as Error).message}), ignored`] };
  }
  if (!isPlain(raw)) return { path: file, settings: {}, warnings: [`${file}: not a JSON object, ignored`] };
  const body = isPlain(raw.managedSettings) ? raw.managedSettings : raw;
  const s: OrgSettings = { ...body };
  if (s.maxAutonomyLevel !== undefined && !(s.maxAutonomyLevel in RANK)) {
    warnings.push(`${file}: maxAutonomyLevel must be off, low, medium or high; treated as off`);
    s.maxAutonomyLevel = "off";
  }
  return { path: file, settings: s, warnings };
}

/** The org's autonomy ceiling, or undefined when none. */
export function orgMaxAutonomy(env: Record<string, string | undefined> = process.env): AutonomyLevel | undefined {
  return loadOrgSettings(env)?.settings.maxAutonomyLevel;
}

/** Lowers `level` to the ceiling. */
export function clampAutonomy(level: AutonomyLevel, max: AutonomyLevel | undefined): AutonomyLevel {
  return max !== undefined && RANK[level] > RANK[max] ? max : level;
}

export function autonomyAllowed(level: AutonomyLevel, max: AutonomyLevel | undefined): boolean {
  return max === undefined || RANK[level] <= RANK[max];
}

/** Is this model usable under the policy? `ids` are the model's id and API name. */
export function modelAllowed(policy: ModelPolicy | undefined, ids: string[], isCustom: boolean): boolean {
  if (!policy) return true;
  if (isCustom && policy.allowCustomModels === false) return false;
  const blocked = strings(policy.blockedModelIds);
  if (blocked?.some((b) => ids.includes(b))) return false;
  const allowed = strings(policy.allowedModelIds);
  if (allowed && !ids.some((i) => allowed.includes(i))) return false;
  return true;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Applies the org level to already-merged lower-level settings. Returns a new object and the top-level keys the org set
 * (for the "[managed by org]" label). `defaults` are the built-in command lists, used when a lower level set none.
 */
export function applyOrg(
  lower: Record<string, unknown>,
  org: OrgSettings,
  defaults: { allow: string[]; deny: string[]; block: string[] },
  mergeFn: (base: Record<string, unknown>, over: Record<string, unknown>) => Record<string, unknown>,
): { settings: Record<string, unknown>; managedKeys: string[] } {
  const out = mergeFn(lower, org);
  const managed = Object.keys(org);
  // Command lists: deny and block only grow; an org allowlist is the whole allowlist.
  if (org.commandDenylist) out.commandDenylist = uniq([...(strings(lower.commandDenylist) ?? defaults.deny), ...org.commandDenylist]);
  if (org.commandBlocklist) out.commandBlocklist = uniq([...(strings(lower.commandBlocklist) ?? defaults.block), ...org.commandBlocklist]);
  if (org.commandAllowlist) out.commandAllowlist = [...org.commandAllowlist];
  // Model policy: the org's copy replaces any lower copy (a deep merge could let a lower level re-allow a blocked model).
  if (org.modelPolicy) out.modelPolicy = { ...org.modelPolicy };
  if (org.modelPolicy?.allowCustomModels === false) {
    out.customModels = Array.isArray(org.customModels) ? [...org.customModels] : [];
  } else if (Array.isArray(org.customModels)) {
    out.customModels = [...org.customModels, ...(Array.isArray(lower.customModels) ? lower.customModels : [])];
  }
  // Sandbox: the stricter setting wins (not a plain override, so a lower level cannot widen an org allow list).
  if (org.sandbox) out.sandbox = mergeSandboxOrg(org.sandbox as SandboxSettings, lower.sandbox as SandboxSettings | undefined);
  // Autonomy ceiling applies to the default a lower level picked.
  if (org.maxAutonomyLevel) {
    const d = isPlain(out.sessionDefaultSettings) ? { ...out.sessionDefaultSettings } : {};
    const cur = d.autonomyLevel as AutonomyLevel | undefined;
    if (cur && cur in RANK) d.autonomyLevel = clampAutonomy(cur, org.maxAutonomyLevel);
    out.sessionDefaultSettings = d;
  }
  return { settings: out, managedKeys: managed };
}

/** "[managed by org]" when the org set `key`, else "". */
export function managedLabel(managedKeys: readonly string[] | undefined, key: string): string {
  return managedKeys?.includes(key) ? "[managed by org]" : "";
}

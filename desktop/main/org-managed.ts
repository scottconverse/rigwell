// Which settings the organization manages (spec 12.2 org level), for the "[managed by org]" labels on the settings pages.
// The file is named by RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH (the settings object, or {"managedSettings": {...}}); the
// keys it sets win over every other level. This mirrors src/storage/org.ts without importing the daemon's code.
import { readFileSync, statSync } from "node:fs";

export const ORG_ENV = "RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH";
export interface OrgManaged { managed: boolean; keys: string[]; maxAutonomyLevel?: string }

export function readOrgManaged(env: Record<string, string | undefined> = process.env): OrgManaged {
  const none: OrgManaged = { managed: false, keys: [] };
  const file = env[ORG_ENV];
  if (!file) return none;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return none;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return none;
    const body = raw.managedSettings && typeof raw.managedSettings === "object" && !Array.isArray(raw.managedSettings) ? raw.managedSettings : raw;
    const keys = Object.keys(body).filter((k) => k !== "managedSettings");
    return { managed: keys.length > 0, keys, ...(typeof body.maxAutonomyLevel === "string" ? { maxAutonomyLevel: body.maxAutonomyLevel } : {}) };
  } catch { return none; }
}

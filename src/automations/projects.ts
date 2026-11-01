// Registry of known project folders whose `.rigwell/automations` the scheduler scans (spec 16.1).
// Lives in $RIGWELL_HOME/automation-projects.json so a restarted daemon still finds project automations.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { atomicWrite } from "./store.ts";

const file = () => join(rigwellHome(), "automation-projects.json");

export function readProjectRegistry(): string[] {
  try {
    const j = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(j?.projects) ? j.projects.filter((x: unknown): x is string => typeof x === "string" && x.length > 0) : [];
  } catch { return []; }
}

export function writeProjectRegistry(projects: string[]) {
  try {
    mkdirSync(rigwellHome(), { recursive: true });
    atomicWrite(file(), JSON.stringify({ projects: [...new Set(projects)].sort() }, null, 2) + "\n");
  } catch { /* the registry is a convenience; a failed write never stops automations */ }
}

/** True when the folder has an automations directory worth remembering. */
export function hasProjectAutomations(dir: string): boolean {
  return existsSync(join(dir, ".rigwell", "automations"));
}

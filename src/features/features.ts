import { FEATURES, parseFeatures, type FeatureId } from "./config.ts";
import { loadSettings } from "../storage/settings.ts";
import { rigwellHome } from "../storage/paths.ts";

function settings() { return loadSettings({ cwd: rigwellHome(), trusted: false }).settings; }
export function featureEnabled(id: FeatureId, legacyOptIn = false) { return parseFeatures(settings().features)[id] ?? legacyOptIn; }
export function readFeatures() {
  const s = settings(), configured = parseFeatures(s.features);
  const legacy: Record<FeatureId, boolean> = { script_subagents: s.allowSubagentsInScripts === true, nested_workstreams: (s.workstreams as any)?.allowNestedSpawn === true };
  return { configured, features: FEATURES.map((f) => ({ ...f, enabled: configured[f.id] ?? legacy[f.id], source: configured[f.id] === undefined ? legacy[f.id] ? "legacy opt-in" : "default off" : "features map" })) };
}
export const featureMethods = { get_features: () => readFeatures() };

// Only existing opt-in behavior belongs here. Core features remain available independently of Labs.
export const FEATURES = [
  { id: "script_subagents", name: "Subagents inside Scripts", description: "Allow Script programs to invoke Task. New session engines only; normal Task permissions and depth limits still apply." },
  { id: "nested_workstreams", name: "Nested Workstream controls", description: "Allow nested controls in newly approved Workstreams. Disabling also blocks new nested controls in existing streams. Member tool ceilings and depth limits still apply." },
] as const;
export type FeatureId = typeof FEATURES[number]["id"];
export function parseFeatures(value: unknown): Partial<Record<FeatureId, boolean>> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.entries(value).some(([key, enabled]) => !FEATURES.some((f) => f.id === key) || typeof enabled !== "boolean")) throw new Error("features must map registered Labs IDs to booleans");
  return { ...value };
}

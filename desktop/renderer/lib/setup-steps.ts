export type SetupKey = "model" | "session" | "tools";
export interface SetupInput { models: number; hasSession: boolean; tools: number | null }
export interface SetupState { done: number; total: 3; next?: SetupKey }
export const SETUP_LABELS: Record<SetupKey, string> = { model: "Connect a model", session: "Start your first session", tools: "Connect your tools" };
/** null while the tool count is unknown (older service or error): the card is not shown. */
export function setupSteps(i: SetupInput): SetupState | null {
  if (i.tools === null) return null;
  const steps: [SetupKey, boolean][] = [["model", i.models > 0], ["session", i.hasSession], ["tools", i.tools > 0]];
  return { done: steps.filter(([, d]) => d).length, total: 3, next: steps.find(([, d]) => !d)?.[0] };
}

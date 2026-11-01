// Automations page logic (spec §16.7). Pure functions.
export interface AutomationRow {
  id: string; name: string; description?: string; isValid: boolean; invalidReason?: string; schedule?: string; timezone?: string; trigger: string;
  paused: boolean; status: string; nextRunAt?: number; lastRunAt?: number; lastRunStatus?: string; lastRunSessionId?: string; runCount: number;
  instructions?: string; workingDirectory?: string; webhookPath?: string; webhookPort?: number;
}
export interface RunRow { runId: string; sessionId?: string; status: string; trigger: string; attempt: number; startedAt: number; finishedAt?: number; failureReason?: string; errorMessage?: string }

export const SCHEDULE_PRESETS: { id: string; label: string; value: string }[] = [
  { id: "hourly", label: "Every hour", value: "hourly" },
  { id: "daily", label: "Every day at 9:00", value: "daily" },
  { id: "weekly", label: "Every Monday at 9:00", value: "weekly" },
  { id: "monthly", label: "First of the month at 9:00", value: "monthly" },
  { id: "custom", label: "Custom", value: "" },
];

export interface CreateForm { name: string; preset: string; custom: string; instructions: string; workingDirectory: string; trigger: "schedule" | "webhook" }

/** Validates the form; returns the create_automation params or an error message. */
export function buildCreate(f: CreateForm): { params: Record<string, unknown> } | { error: string } {
  const name = f.name.trim();
  if (!name) return { error: "Give the automation a name." };
  if (!f.instructions.trim()) return { error: "Write the instructions the agent should follow." };
  const params: Record<string, unknown> = { name, instructions: f.instructions, trigger: f.trigger };
  if (f.workingDirectory.trim()) params.workingDirectory = f.workingDirectory.trim();
  if (f.trigger === "schedule") {
    const preset = SCHEDULE_PRESETS.find((p) => p.id === f.preset);
    const schedule = preset && preset.id !== "custom" ? preset.value : f.custom.trim();
    if (!schedule) return { error: 'Choose a schedule, or enter one such as "every 30m" or "0 9 * * 1-5".' };
    params.schedule = schedule;
  }
  return { params };
}

export function statusLabel(a: Pick<AutomationRow, "status" | "isValid" | "invalidReason">): string {
  if (!a.isValid) return a.invalidReason ? `Invalid: ${a.invalidReason}` : "Invalid";
  return a.status === "degraded" ? "Needs attention" : a.status[0].toUpperCase() + a.status.slice(1);
}
export const tabMatches = (a: AutomationRow, tab: "Active" | "Paused") => (tab === "Paused" ? a.paused : !a.paused);

export function duration(r: Pick<RunRow, "startedAt" | "finishedAt">): string {
  if (!r.finishedAt) return "running";
  const s = Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function when(ms?: number, now = Date.now()): string {
  if (!ms) return "never";
  const d = ms - now;
  const a = Math.abs(d) / 1000;
  const t = a < 60 ? "a moment" : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return d >= 0 ? `in ${t}` : `${t} ago`;
}

/** The "automations stop when the app quits" warning: shown while there is an active automation and it was not dismissed. */
export function showQuitWarning(automations: AutomationRow[], dismissed: boolean): boolean {
  return !dismissed && automations.some((a) => a.isValid && !a.paused);
}

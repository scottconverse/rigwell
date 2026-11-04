// Mission Control view model (spec §15.8, §14.3). Pure functions over the mission_get / mission_list data and notifications.
export type MissionState = "planning" | "awaiting_input" | "initializing" | "running" | "orchestrator_turn" | "completed" | "paused";
export interface MissionFeature { id: string; description: string; skillName: string; milestone: string; status: "pending" | "in_progress" | "completed" | "cancelled"; currentWorkerSessionId?: string; workerSessionIds?: string[] }
export interface MissionListRow { sessionId: string; missionId?: string; state: string; title?: string }
export interface MissionDetail {
  exists: boolean; state: string; features: MissionFeature[]; handoffs: any[]; progress?: any; progressLog: any[]; pauseReason?: string;
  updatedAt?: string; tokenUsage?: Record<string, number>; workingDirectory?: string; missionId?: string;
}

export type MissionTab = "All" | "Running" | "Paused" | "Completed";
export const MISSION_TABS: MissionTab[] = ["All", "Running", "Paused", "Completed"];
const RUNNING = new Set(["initializing", "running", "orchestrator_turn"]);
const PAUSED = new Set(["paused", "awaiting_input"]);

export function tabOf(state: string): MissionTab {
  if (RUNNING.has(state)) return "Running";
  if (PAUSED.has(state)) return "Paused";
  if (state === "completed") return "Completed";
  return "All";
}
export const inTab = (state: string, tab: MissionTab) => tab === "All" || tabOf(state) === tab;

const LABELS: Record<string, string> = {
  planning: "Planning", awaiting_input: "Waiting for you", initializing: "Starting", running: "Running", orchestrator_turn: "Orchestrator working", completed: "Completed", paused: "Paused",
};
export const stateLabel = (s: string) => LABELS[s] ?? s;

const PAUSE_TEXT: Record<string, string> = {
  user_paused: "You paused this mission.",
  crash_recovery: "The background service restarted while this mission was running, so it was paused. Resume it from the session.",
  retry_limit: "A feature failed too many times. Resume to allow more attempts.",
  scope_growth: "The plan grew well past its first size. Review it, then resume.",
  billing_error: "The model provider reported a billing problem. Fix it, then resume.",
};
export function pauseBanner(reason?: string): string | undefined {
  if (!reason) return undefined;
  return PAUSE_TEXT[reason] ?? `Paused: ${reason.replace(/_/g, " ")}.`;
}

export function counts(features: MissionFeature[]) {
  const c = { total: features.length, completed: 0, in_progress: 0, pending: 0, cancelled: 0 };
  for (const f of features) c[f.status]++;
  return c;
}
export const percentDone = (features: MissionFeature[]) => { const c = counts(features); const live = c.total - c.cancelled; return live ? Math.round((c.completed / live) * 100) : 0; };

export interface WorkerRow { workerSessionId: string; featureId: string; description: string; active: boolean; exitCode?: number }
/** Workers from the features; the feature's current worker is active until a completion notification arrives for it. */
export function workerRows(features: MissionFeature[], exits: Record<string, number> = {}): WorkerRow[] {
  const rows: WorkerRow[] = [];
  for (const f of features) {
    for (const id of f.workerSessionIds ?? []) rows.push({ workerSessionId: id, featureId: f.id, description: f.description, active: f.currentWorkerSessionId === id && !(id in exits), exitCode: exits[id] });
  }
  return rows;
}

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export function tokenTotal(u?: Record<string, number>): number { return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0) : 0; }

export type MissionNote = { type: string; [k: string]: any };
/** Applies a mission notification to the detail. Unknown notifications return the same object. */
export function applyNote(d: MissionDetail, n: MissionNote, exits: Record<string, number>): MissionDetail {
  switch (n.type) {
    case "mission_state_changed": return { ...d, exists: true, state: n.state, updatedAt: n.updatedAt ?? d.updatedAt, pauseReason: n.state === "paused" ? d.pauseReason : undefined };
    case "mission_features_changed": return { ...d, exists: true, features: n.features ?? d.features };
    case "mission_progress_entry": return { ...d, progressLog: [...d.progressLog, n.progressLog].slice(-200) };
    case "mission_worker_completed": exits[n.workerSessionId] = n.exitCode ?? 0; return { ...d };
    default: return d;
  }
}

export function fromGet(r: any): MissionDetail {
  return {
    exists: r.exists !== false, state: r.state ?? "planning", features: r.features ?? [], handoffs: r.handoffs ?? [], progress: r.progress, progressLog: r.progressLog ?? [],
    pauseReason: r.pauseReason, updatedAt: r.updatedAt, tokenUsage: r.tokenUsage, workingDirectory: r.workingDirectory, missionId: r.missionId,
  };
}

export type ReadinessReply = { entered: boolean; readiness?: { status: string; [k: string]: any }; modelSwitched?: string };
export function readinessText(r: ReadinessReply["readiness"]): string {
  if (!r) return "The folder is not ready for a mission.";
  const items: string[] = Array.isArray((r as any).problems) ? (r as any).problems : Array.isArray((r as any).issues) ? (r as any).issues : [];
  return items.length ? items.map(String).join("\n") : `Readiness: ${r.status}`;
}

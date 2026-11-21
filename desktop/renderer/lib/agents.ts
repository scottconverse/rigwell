// The Agents tab view model. Pure functions over get_workstream and mission_get data and their notifications.
import type { AgentEntry } from "../../../src/workstreams/store.ts";
import type { MissionFeature } from "./missions.ts";

export interface AgentRow {
  id: string; kind: "workstream" | "mission"; name: string; status: string; active: boolean;
  step?: string; startedAt?: number; role?: string; model?: string; tokens?: number; costUsd?: number; costKnown?: boolean;
  branch?: string; files?: string[]; sessionId: string;
}
export interface CurrentWorker { workerSessionId: string; featureId: string; description: string; startedAt: number; step?: string }

const LABELS: Record<string, string> = { starting: "Starting", working: "Working", waiting_input: "Waiting for you", idle: "Idle", interrupted: "Stopped", failed: "Failed" };
const ACTIVE = new Set(["starting", "working", "waiting_input"]);

export function memberRow(a: AgentEntry): AgentRow {
  const active = ACTIVE.has(a.status);
  return {
    id: a.agentId, kind: "workstream", name: a.name, status: LABELS[a.status] ?? a.status, active, step: active ? a.currentStep : undefined, startedAt: a.startedAt,
    role: a.role, model: a.model, tokens: a.tokens, costUsd: a.costUsd, costKnown: a.costKnown, branch: a.branch, files: a.writeFiles, sessionId: a.sessionId,
  };
}

/** Workstream members, without archived ones. */
export const memberRows = (roster: AgentEntry[]) => roster.filter((a) => a.status !== "archived").map(memberRow);

/** Mission workers. Only the worker the daemon reports as current counts as Working. */
export function workerAgentRows(features: MissionFeature[], current?: CurrentWorker | null): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const f of features) for (const id of f.workerSessionIds ?? []) {
    const live = current?.workerSessionId === id ? current : undefined;
    rows.push({ id, kind: "mission", name: f.description, status: live ? "Working" : "Not running", active: !!live, step: live?.step, startedAt: live?.startedAt, role: `Mission worker for ${f.id}`, sessionId: id });
  }
  if (current && !rows.some((r) => r.id === current.workerSessionId)) rows.push({ id: current.workerSessionId, kind: "mission", name: current.description, status: "Working", active: true, step: current.step, startedAt: current.startedAt, role: `Mission worker for ${current.featureId}`, sessionId: current.workerSessionId });
  return rows;
}

/** Applies one live change. Returns the same list when nothing changes. */
export function applyAgentEvent(rows: AgentRow[], n: { type: string; [k: string]: any }): AgentRow[] {
  if (n.type === "workstream_agent_status" && n.agent) {
    if (n.agent.status === "archived") return rows.filter((r) => r.id !== n.agent.agentId);
    const next = memberRow(n.agent), at = rows.findIndex((r) => r.id === next.id);
    return at < 0 ? [...rows, next] : rows.map((r, i) => i === at ? next : r);
  }
  if (n.type === "mission_worker_activity" && typeof n.step === "string") {
    return rows.map((r) => r.id === n.workerSessionId && r.active ? { ...r, step: n.step || undefined } : r);
  }
  return rows;
}

/** These events change which workers exist, so the tab reads the full data again. */
export const needsAgentReload = (type: string) => ["workstream_updated", "mission_worker_started", "mission_worker_completed", "mission_state_changed", "mission_features_changed"].includes(type);

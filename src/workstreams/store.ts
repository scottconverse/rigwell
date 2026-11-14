// Durable local Workstream state (spec 15.10). The daemon owns metadata and append-only event logs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutonomyLevel, ReasoningEffort } from "../core/types.ts";
import { rigwellHome } from "../storage/paths.ts";

export type WorkstreamState = "proposed" | "active" | "paused" | "completed" | "archived";
export type AgentStatus = "starting" | "working" | "idle" | "waiting_input" | "interrupted" | "failed" | "archived";
export interface WorkstreamSettings {
  enabled: boolean;
  maxConcurrentAgents: number;
  allowNestedSpawn: boolean;
  autoRejectMemberPrompts: boolean;
  defaultMemberModel?: string;
  defaultMemberReasoningEffort?: ReasoningEffort;
}
export interface Workstream {
  id: string; title: string; goal: string; plan: string; leadSessionId: string; cwd: string;
  state: WorkstreamState; createdAt: number; updatedAt: number;
  budget?: { maxTokens?: number; maxCostUsd?: number; maxWallMinutes?: number };
  settings: WorkstreamSettings;
}
export interface AgentEntry {
  agentId: string; name: string; role: string; sessionId: string; cwd: string;
  worktreePath?: string; branch?: string; model: string; reasoningEffort: ReasoningEffort;
  autonomyLevel: AutonomyLevel; status: AgentStatus; lastActivityAt: number;
  lastSummary?: string; tokens: number; costUsd: number; tools?: string[];
  parentAgentId?: string; depth: number;
}
export interface WorkstreamEvent { id: string; ts: number; type: string; [key: string]: unknown }
export type MessagePriority = "now" | "next" | "later";
export interface WorkstreamMessage {
  id: string; ts: number; from: string; to: string; priority: MessagePriority; text: string;
  deliveredAt?: number; readAt?: number;
}

export const workstreamsRoot = () => join(rigwellHome(), "workstreams");
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid workstream id"); return id; };
export function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}
export class WorkstreamStore {
  readonly dir: string;
  constructor(readonly id: string, root = workstreamsRoot()) { this.dir = join(root, safeId(id)); }
  path(name: string) { return join(this.dir, name); }
  exists() { return existsSync(this.path("workstream.json")); }
  create(workstream: Workstream) {
    if (this.exists()) throw new Error("Workstream already exists");
    mkdirSync(this.path("shared"), { recursive: true, mode: 0o700 });
    atomicJson(this.path("roster.json"), []);
    atomicJson(this.path("listeners.json"), []);
    for (const name of ["messages.jsonl", "events.jsonl"]) writeFileSync(this.path(name), "", { mode: 0o600 });
    atomicJson(this.path("workstream.json"), workstream);
    this.event("workstream_accepted", { leadSessionId: workstream.leadSessionId });
  }
  read(): Workstream { return JSON.parse(readFileSync(this.path("workstream.json"), "utf8")); }
  update(patch: Partial<Workstream>) {
    const current = this.read();
    const next = { ...current, ...patch, id: current.id, leadSessionId: current.leadSessionId, updatedAt: Date.now() };
    atomicJson(this.path("workstream.json"), next); return next;
  }
  roster(): AgentEntry[] { return JSON.parse(readFileSync(this.path("roster.json"), "utf8")); }
  writeRoster(agents: AgentEntry[]) { atomicJson(this.path("roster.json"), agents); }
  agent(id: string) { return this.roster().find((a) => a.agentId === id); }
  updateAgent(id: string, patch: Partial<AgentEntry>) {
    const rows = this.roster(), index = rows.findIndex((a) => a.agentId === id);
    if (index < 0) throw new Error(`Unknown agent ${id}`);
    rows[index] = { ...rows[index]!, ...patch, agentId: id, sessionId: rows[index]!.sessionId };
    this.writeRoster(rows); return rows[index]!;
  }
  event(type: string, details: Record<string, unknown> = {}): WorkstreamEvent {
    const event = { ...details, id: crypto.randomUUID(), ts: Date.now(), type };
    appendFileSync(this.path("events.jsonl"), JSON.stringify(event) + "\n"); return event;
  }
  events(): WorkstreamEvent[] {
    return readFileSync(this.path("events.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  /** Revisions append with the same id; folding the log preserves one current message per id. */
  messages(): WorkstreamMessage[] {
    const messages = new Map<string, WorkstreamMessage>();
    for (const line of readFileSync(this.path("messages.jsonl"), "utf8").split("\n").filter(Boolean)) {
      try { const message = JSON.parse(line); messages.set(message.id, message); } catch { /* incomplete final append after a crash */ }
    }
    return [...messages.values()];
  }
  writeMessage(message: WorkstreamMessage) {
    appendFileSync(this.path("messages.jsonl"), JSON.stringify(message) + "\n", { mode: 0o600 });
    return message;
  }
}
export function listWorkstreamStores(root = workstreamsRoot()): WorkstreamStore[] {
  let ids: string[]; try { ids = readdirSync(root); } catch { return []; }
  return ids.filter((id) => /^[a-zA-Z0-9_-]+$/.test(id)).map((id) => new WorkstreamStore(id, root)).filter((s) => s.exists());
}

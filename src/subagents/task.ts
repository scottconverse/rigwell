// Task tool core (spec §5.9 "Task tool", "Child session", "Limits"; prompts.md §5.14).
// The child-session machinery is the lead's `spawnChild` callback; this module enforces limits and builds the brief.
import { randomUUID } from "node:crypto";
import type { AutonomyLevel } from "../core/types.ts";
import { normalizeName } from "../config/frontmatter.ts";
import type { CustomAgent } from "./agents.ts";

export interface TaskInput {
  description: string;
  prompt: string;
  /** Name of a custom agent. Default: a general agent. */
  agent?: string;
  background?: boolean;
}

export class TaskError extends Error {
  constructor(public code: "depth" | "limit" | "unknown_agent" | "invalid_input", message: string) { super(message); }
}

// ---------------------------------------------------------------- limits
export interface TaskLimitConfig {
  /** Max nesting depth. Default 1, clamp 1. */
  maxDepth?: number;
  /** Active descendants per root session. Default 5, clamp 25. */
  perRoot?: number;
  /** Active Task subagents per process. Default 10, clamp 100. */
  perProcess?: number;
}
export const DEFAULT_LIMITS = { maxDepth: 1, perRoot: 5, perProcess: 10 } as const;
const clamp = (v: number | undefined, def: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : def;

/** Tracks active subagents per root session and per process. Share one instance per process. */
export class TaskLimits {
  readonly maxDepth: number;
  readonly perRoot: number;
  readonly perProcess: number;
  private byRoot = new Map<string, number>();
  private total = 0;
  constructor(c: TaskLimitConfig = {}) {
    this.maxDepth = clamp(c.maxDepth, DEFAULT_LIMITS.maxDepth, 1);
    this.perRoot = clamp(c.perRoot, DEFAULT_LIMITS.perRoot, 25);
    this.perProcess = clamp(c.perProcess, DEFAULT_LIMITS.perProcess, 100);
  }
  /** Returns a release function (idempotent), or null when a limit is reached. */
  acquire(rootSessionId: string): (() => void) | null {
    if (this.total >= this.perProcess || (this.byRoot.get(rootSessionId) ?? 0) >= this.perRoot) return null;
    this.total++;
    this.byRoot.set(rootSessionId, (this.byRoot.get(rootSessionId) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return; done = true;
      this.total--;
      const n = (this.byRoot.get(rootSessionId) ?? 1) - 1;
      if (n <= 0) this.byRoot.delete(rootSessionId); else this.byRoot.set(rootSessionId, n);
    };
  }
  active(rootSessionId?: string): number { return rootSessionId ? this.byRoot.get(rootSessionId) ?? 0 : this.total; }
}

// ---------------------------------------------------------------- brief
export interface ParentContext {
  sessionId: string;
  /** The top-level session the whole tree hangs off (== sessionId at depth 0). */
  rootSessionId: string;
  /** 0 for a top-level session. */
  depth: number;
  cwd: string;
  modelId: string;
  reasoningEffort?: string;
  autonomy: AutonomyLevel;
}

export interface ChildOptions {
  description: string;
  parentSessionId: string;
  rootSessionId: string;
  /** Depth of the child (parent's + 1). Children never get the Task tool. */
  depth: number;
  cwd: string;
  /** Resolved model id (the agent's model, or the parent's when `inherit`). */
  modelId: string;
  reasoningEffort?: string;
  /** Autonomy for the child: the parent's, capped at low for read-only agents. */
  autonomy: AutonomyLevel;
  /** Allow-list for the child; undefined = the normal set. `Task` is always removed. */
  allowedTools?: string[];
  /** Tool names that must be removed from the child's set. Always includes `Task`. */
  removeTools: string[];
  mcpServers?: string[];
  /** Custom agent's system prompt (append it to the base system prompt), if an agent was chosen. */
  agentName?: string;
  agentSystemPrompt?: string;
  /** Child is failed after this much inactivity (15 min default). */
  inactivityTimeoutMs: number;
  signal?: AbortSignal;
}

export type ChildStatus = "completed" | "failed" | "cancelled";
export interface ChildOutcome {
  childSessionId: string;
  status: ChildStatus;
  /** The child's final report (or an error text when failed). */
  report: string;
  toolUseCount?: number;
  durationMs?: number;
  error?: string;
  tokenUsage?: Record<string, number>;
}
export type SpawnChild = (prompt: string, opts: ChildOptions) => Promise<ChildOutcome>;

export const CHILD_INACTIVITY_MS = 15 * 60_000;
/** Tools that only read: an agent restricted to these is "read-only" and capped at low autonomy. */
export const READ_ONLY_TOOLS = ["Read", "LS", "Grep", "Glob", "Skill"];
const AUTONOMY_RANK: AutonomyLevel[] = ["off", "low", "medium", "high"];

export function childAutonomy(parent: AutonomyLevel, agentTools?: string[]): AutonomyLevel {
  const readOnly = !!agentTools && agentTools.length > 0 && agentTools.every((t) => READ_ONLY_TOOLS.includes(t));
  if (!readOnly) return parent;
  return AUTONOMY_RANK.indexOf(parent) > 1 ? "low" : parent;
}

export function resolveChildModel(agent: CustomAgent | undefined, parent: ParentContext): { modelId: string; reasoningEffort?: string } {
  const inherit = !agent || agent.model === "inherit";
  return { modelId: inherit ? parent.modelId : agent!.model, reasoningEffort: agent?.reasoningEffort ?? parent.reasoningEffort };
}

/** Build the child options (pure; no limits). Throws TaskError for bad input or an unknown agent. */
export function buildChild(parent: ParentContext, input: TaskInput, agents: CustomAgent[], limits: TaskLimits): { prompt: string; opts: ChildOptions } {
  if (parent.depth >= limits.maxDepth) throw new TaskError("depth", "Task is not available to subagents (nesting depth limit reached).");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new TaskError("invalid_input", "Task: prompt is required.");
  if (typeof input.description !== "string" || !input.description.trim()) throw new TaskError("invalid_input", "Task: description is required.");
  let agent: CustomAgent | undefined;
  if (input.agent && input.agent.trim()) {
    const n = normalizeName(input.agent.trim());
    agent = agents.find((a) => a.name === n);
    if (!agent) {
      throw new TaskError("unknown_agent", `Task: no agent named "${input.agent}".${agents.length ? ` Available: ${agents.map((a) => a.name).join(", ")}.` : " No custom agents are defined."}`);
    }
  }
  const tools = agent?.tools?.filter((t) => t !== "Task");
  const { modelId, reasoningEffort } = resolveChildModel(agent, parent);
  return {
    // The child starts from the prompt only, never the parent's history.
    prompt: input.prompt,
    opts: {
      description: input.description.trim(), parentSessionId: parent.sessionId, rootSessionId: parent.rootSessionId,
      depth: parent.depth + 1, cwd: parent.cwd, modelId, reasoningEffort,
      autonomy: childAutonomy(parent.autonomy, tools), allowedTools: tools, removeTools: ["Task"],
      mcpServers: agent?.mcpServers, agentName: agent?.name, agentSystemPrompt: agent?.systemPrompt || undefined,
      inactivityTimeoutMs: CHILD_INACTIVITY_MS,
    },
  };
}

// ---------------------------------------------------------------- the tool
export interface TaskSummary {
  childSessionId: string;
  subagentType: string;
  description: string;
  status: ChildStatus;
  toolUseCount: number;
  durationMs: number;
}
export interface TaskResult {
  report: string;
  summary: TaskSummary;
  outcome: ChildOutcome;
}
export interface TaskStarted {
  /** Background start: returned at once. `done` resolves with the result when the child ends (never rejects). */
  jobId: string;
  done: Promise<TaskResult>;
}

export interface RunTaskDeps {
  parent: ParentContext;
  agents: CustomAgent[];
  limits: TaskLimits;
  spawnChild: SpawnChild;
  signal?: AbortSignal;
}

async function execute(prompt: string, opts: ChildOptions, deps: RunTaskDeps, release: () => void): Promise<TaskResult> {
  const t0 = Date.now();
  let outcome: ChildOutcome;
  try {
    outcome = await deps.spawnChild(prompt, { ...opts, signal: deps.signal });
  } catch (e) {
    const msg = (e as Error).message;
    outcome = { childSessionId: "", status: "failed", report: `Subagent failed: ${msg}`, error: msg };
  } finally { release(); }
  return {
    report: outcome.report,
    outcome,
    summary: {
      childSessionId: outcome.childSessionId, subagentType: opts.agentName ?? "general", description: opts.description,
      status: outcome.status, toolUseCount: outcome.toolUseCount ?? 0, durationMs: outcome.durationMs ?? Date.now() - t0,
    },
  };
}

/**
 * Task tool. Foreground: resolves with `{report, summary}`. `background: true`: resolves at once with `{jobId, done}`.
 * Throws TaskError for depth/limit/unknown agent/invalid input (becomes the tool error).
 */
export async function runTask(input: TaskInput, deps: RunTaskDeps): Promise<TaskResult | TaskStarted> {
  const { prompt, opts } = buildChild(deps.parent, input, deps.agents, deps.limits);
  const release = deps.limits.acquire(deps.parent.rootSessionId);
  if (!release) throw new TaskError("limit", "Task limit reached: too many subagents are running. Wait for a task to finish, then try again.");
  const run = execute(prompt, opts, deps, release);
  if (input.background) return { jobId: `task-${randomUUID().slice(0, 8)}`, done: run };
  return run;
}

export const isStarted = (r: TaskResult | TaskStarted): r is TaskStarted => "jobId" in r;

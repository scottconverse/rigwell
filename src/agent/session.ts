// One agent session: holds the transcript, runs turns, emits notifications (spec §3.1.7, §4).
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  AutonomyLevel, CommandLists, ContentBlock, InteractionMode, Message, ModelAdapter, ModelConfig,
  PermissionDecision, ReasoningEffort, TokenUsage, Tool, ToolResultBlock, ToolUseBlock, FileReadRecord,
  AskQuestion, ImageBlock, SessionServices, TodoItem,
} from "../core/types.ts";
import type { ModelRequest, ToolContext, ToolExecutionMode, ToolOutput } from "../core/types.ts";
import { SnapshotRecorder } from "../snapshots/index.ts";
import { ModelError, zeroUsage } from "../core/types.ts";
import { JobManager, type Job } from "../jobs/manager.ts";
import { ToolCallError } from "../script/bindings.ts";
import { ScriptService, type ScriptLimits } from "../script/service.ts";
import { contextBlocks, guardText, todosBlock } from "./prompts.ts";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";
import { DEFAULT_GUARDS, RepeatTracker, detectCycle, resolveGuards, type Cycle, type GuardConfig, type GuardSettings } from "./guards.ts";
import {
  buildSummarizerRequest, collectSummary, contextTextBlocks, messagesTokens, pickCut, preambleBlocks, preambleMessage,
  resolveCompaction, type CompactionConfig,
} from "./compaction.ts";
import { AUTO_MODEL_ID, route, type RouteChoice, type RouterConfig } from "./router.ts";
import type { CompactionRecord } from "../storage/transcript.ts";
import { DeferredRegistry, type DeferredState } from "./deferred.ts";
import { RequestBuilder } from "./request.ts";
import { contextBreakdown } from "./context-stats.ts";
import { estimateTokens } from "./budget.ts";
import type { HookRunner } from "../hooks/index.ts";
import type { PermissionModeName } from "../hooks/runner.ts";
import { InstructionLoader } from "../instructions/index.ts";
import { renderAdditionalSkills, SkillRegistry } from "../skills/skills.ts";
import { McpManager, isMcpAllowed, mcpTool, rememberMcp, type McpServerConfig } from "../mcp/index.ts";
import { isStarted, runTask, TaskError, type ChildOptions, type ChildOutcome, type ParentContext, type TaskInput, type TaskLimits } from "../subagents/task.ts";
import { agentCatalog, type CustomAgent } from "../subagents/agents.ts";
import { exitSpecModeTool, recommendMissionTool, upgradeModelTool, saveSpec, skillTool, specFileName, specSaveFolder, taskTool } from "./extra-tools.ts";
import { TaskJob } from "../jobs/task.ts";
import { resolveProfile, type ModelProfile, type ProfileSettings } from "./profiles.ts";
import { schemaProblem, validate } from "./json-schema.ts";
import {
  createAskUserTool, createStructuredOutputTool, createTaskOutputTool, createTaskStopTool, createTodoWriteTool, renderTodoList,
} from "../tools/session-tools.ts";
import { attachSandbox, detachSandbox, sandboxStatus, sandboxStatusLabel } from "../sandbox/controller.ts";
import { autonomyAllowed, clampAutonomy } from "../storage/org.ts";
import { contextSavingsPercent, handoffLevel, saveHandoff } from "./handoff.ts";
import { reportFalsePositives, secretFindingsFor } from "../permissions/secretscan.ts";

export type WorkingState =
  | "idle" | "thinking" | "streaming_assistant_message" | "waiting_for_tool_confirmation" | "executing_tool"
  | "compacting_conversation";

/** The model's answer was one block repeating (spec 4.2): the turn ends with an error naming the cycle. */
export class OutputCycleError extends Error {
  constructor(public cycle: Cycle) {
    super(`the same ${cycle.length}-character block repeated ${cycle.repeats} times in the model output.`);
    this.name = "OutputCycleError";
  }
}

/** compact_session while a turn is running. */
export class SessionBusyError extends Error {
  constructor() { super("A turn is running; wait for it to finish or interrupt it before compacting."); this.name = "SessionBusyError"; }
}

export type TurnReason =
  | "completed" | "cancelled" | "permission_rejected" | "error" | "no_approver_available" | "prompt_rejected"
  | "model_authentication_failed" | "model_request_rejected" | "model_provider_unreachable"
  | "model_provider_unavailable" | "model_rate_limited"
  | "structured_output_missing" | "structured_output_invalid" | "structured_output_schema_invalid"
  /** ExitSpecMode was approved with a handoff option: this session ends, a new one starts with the spec as its brief. */
  | "spec_handoff";

export interface SessionTag { name: string; metadata?: Record<string, string> }
/** Settings swapped in while list_tools works out what a session would offer. */
export interface ToolPreview {
  modelId?: string; interactionMode?: InteractionMode; autonomyLevel?: AutonomyLevel; specModeModelId?: string;
  skipPermissions?: boolean; depth?: number; toolIds?: SessionDeps["toolIds"] | null; mode?: ToolExecutionMode;
}
export interface PermissionAnswer { selectedOption: string; comment?: string; editedSpecContent?: string; clientStartsHandoffSession?: boolean; specHandoffId?: string }
export interface AskUserAnswer { cancelled?: boolean; answers: { index: number; question: string; answer: string }[] }
export interface OutputFormat { type: "json_schema"; schema: Record<string, unknown> }

/** JSON-RPC code of a request that died because the connection closed (see protocol/rpc.ts). */
const DISCONNECTED = -32005;

/** A prompt the client has not answered yet (spec 3.1.5 pending lists). */
export interface PendingPrompt {
  requestId: string;
  kind: "permission" | "ask_user";
  params: Record<string, unknown>;
  resolve: (answer: any) => void;
  /** The answer used when the turn is interrupted while the prompt is open. */
  fallback: unknown;
}

/** A user message waiting for its turn. */
export interface QueuedUserMessage { text: string; messageId: string; source?: string; content?: ContentBlock[]; outputFormat?: OutputFormat | null }

/** What a session needs from the connection that owns it. */
export interface SessionHost {
  notify(n: Record<string, unknown>): void;
  /** Present only when a client can answer prompts (stream-jsonrpc). */
  requestPermission?: (params: Record<string, unknown>) => Promise<PermissionAnswer>;
  /** Present only when a client can answer AskUser questions. */
  requestAskUser?: (params: Record<string, unknown>) => Promise<AskUserAnswer>;
}

/** Persistence hooks, implemented over src/storage. */
export interface SessionPersistence {
  appendMessage(msg: Message, parentId: string | null): Promise<void>;
  appendTurnOutcome(o: { turnId: string; reason: string; resultKind: "text" | "structured" | null }): Promise<void>;
  appendCompaction?(rec: CompactionRecord): Promise<void>;
  /** todo_state record (spec 12.1). */
  appendTodoState?(todos: TodoItem[], messageIndex: number): Promise<void>;
  /** Stores a new session title (a record in the transcript plus the settings file). */
  setTitle?(title: string, manual: boolean): Promise<void>;
  saveSettings(s: Record<string, unknown>): Promise<void>;
}

export interface SessionSettings {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  interactionMode: InteractionMode;
  autonomyLevel: AutonomyLevel;
  /** Model that writes compaction summaries (default: the session model). */
  compactionModelId?: string;
  /** Spec mode can use its own model and effort (spec 5.5.7). */
  specModeModelId?: string;
  specModeReasoningEffort?: ReasoningEffort;
}

/** Storage for a subagent's own transcript (spec 5.9 "Child session"). */
export interface ChildStore {
  persistence: SessionPersistence;
  transcriptPath: string;
}

/** What a session needs to run subagents (Task tool). Absent: no Task tool. */
export interface SubagentDeps {
  limits: TaskLimits;
  agents: CustomAgent[];
  /** 0 for a top-level session. */
  depth: number;
  rootSessionId: string;
  /** Creates the child's transcript (session_start with callingSessionId/callingToolUseId, tags). */
  openChild(o: { id: string; cwd: string; title: string; callingSessionId: string; callingToolUseId: string; agentName?: string; depth: number }): ChildStore;
}

export interface HooksFactoryArgs {
  sessionId: string;
  transcriptPath: string;
  notify: (n: any) => void;
  permissionMode: () => PermissionModeName;
}

export interface SessionDeps {
  /** Immutable owner tool ceiling, also applied inside Scripts and descendant tasks. */
  maxToolIds?: string[];
  /** Admission applies to every ordinary turn, including message and background wakes. */
  beforeTurn?: (signal: AbortSignal) => Promise<() => void>;
  onUsage?: (modelId: string, usage: TokenUsage) => void;
  id: string;
  cwd: string;
  settings: SessionSettings;
  resolveModel: (id: string) => ModelConfig | undefined;
  createAdapter: (m: ModelConfig) => ModelAdapter;
  streamWithRetry: (a: ModelAdapter, req: any, opts: any) => AsyncIterable<any>;
  toolsFor: (o: {
    autonomy: AutonomyLevel; skipPermissions: boolean; specMode?: boolean; fileEditProfile?: "apply-patch" | "create-edit"; extraIds?: string[];
  }) => Tool[];
  decide: (tool: string, input: Record<string, unknown>, ctx: any) => PermissionDecision;
  lists: CommandLists;
  skipPermissions: boolean;
  autoRejectPermissionRequests: boolean;
  persistence: SessionPersistence;
  shell: string;
  retryBaseDelayMs?: number;
  /** Models (ids or API names) that run script_only; every other model runs direct_only (spec §4.1). */
  scriptToolModels?: string[];
  /** Per-session override from initialize_session. */
  toolExecutionModeOverride?: ToolExecutionMode;
  scriptLimits?: ScriptLimits;
  /** Restored state (load_session). */
  messages?: Message[];
  tokenUsage?: TokenUsage;
  /** Deferred tools loaded and announced before this session was saved (spec §6.2, §12.1). */
  deferred?: Partial<DeferredState>;
  /** Log sink (cache monitor, guards). */
  log?: (m: string) => void;
  /** Loop guard thresholds (llmRequestTimeout, loopGuards) from settings. */
  guardSettings?: GuardSettings;
  /** Compaction numbers (reserve, target, headroom, caps) and the automatic trigger. */
  compaction?: Partial<CompactionConfig>;
  compactionTokenLimit?: number;
  compactionThresholdCheckEnabled?: boolean;
  /** Candidates for the "auto" model id (spec 4.5). */
  router?: RouterConfig;
  /** Restored from a compaction_state record: messages before the anchor (UI only) and the anchor's id. */
  archived?: Message[];
  compactionAnchorId?: string;
  /** Variables from the session's named environment: added to Execute and background jobs (SessionStart hook exports win). */
  extraEnv?: Record<string, string>;
  /** Removes secret values from tool output before it reaches the transcript, the notifications or the model. */
  redact?: (text: string) => string;
  /** Builds the hook runner for this session (and for each subagent). Absent: no hooks. */
  hooksFor?: (a: HooksFactoryArgs) => HookRunner | undefined;
  transcriptPath?: string;
  /** MCP servers from initialize_session / load_session. Present (even empty): the session starts an McpManager. */
  mcp?: { servers: McpServerConfig[] };
  /** Script runs may start subagents (initialize_session allowSubagentsInScripts). */
  allowSubagentsInScripts?: boolean;
  subagents?: SubagentDeps;
  /** Settings `specSaveDir`. */
  specSaveDir?: string;
  /** Custom subagent: its system prompt, appended after the base blocks. */
  extraSystem?: string[];
  /** Custom subagent: only these tools (by name) are offered. */
  toolFilter?: string[];
  /** True for a subagent session: only tool hooks run. */
  isChild?: boolean;
  /** Restored todo list (load_session). */
  todos?: TodoItem[];
  /** Session-wide structured output (initialize_session / load_session structuredOutputFormat). */
  structuredOutputFormat?: OutputFormat | null;
  /** initialize_session tool id lists (spec 3.1.5). restrict is a hard allowlist. */
  toolIds?: { restrict?: string[]; enabled?: string[]; disabled?: string[]; additional?: string[] };
  /** systemPrompt string (replaces the base prompt) or preset + append (base prompt, then the text). */
  systemPrompt?: string | { type: "preset"; preset?: string; append?: string };
  disableBuiltinSkills?: boolean;
  /** Settings the profile and tool choices read (modelProfiles, fileEditToolProfile). */
  profileSettings?: ProfileSettings;
  /** false: project settings, hooks, instruction files, skills and agents were not loaded (spec 12.2 trustedFolders). */
  projectTrusted?: boolean;
  /** Title state: the stored title and whether the user set it. */
  title?: { value: string; manual: boolean };
  /** false turns off the title side request. Default: on for sessions a client can see. */
  autoTitle?: boolean;
  /** Milliseconds between tool_execution_heartbeat notifications for a running tool. Default 10000. */
  heartbeatMs?: number;
  /** Settings `compactionTokenLimitPerModel`: { modelIdOrApiName: tokens }. */
  compactionTokenLimitPerModel?: Record<string, number>;
  /** Settings `subagentModelSettings`: { model?, reasoningEffort? } for every Task subagent without a model of its own. */
  subagentModelSettings?: { model?: string; reasoningEffort?: ReasoningEffort };
  /** Enters mission mode for this session (the missions module's enter_mission_mode). Absent: RecommendMission is not offered. */
  enterMissionMode?: () => Promise<Record<string, unknown>>;
  /** The session this one continues (a fork's parent, or itself on resume): SessionStart hook previous_session_id. */
  previousSessionId?: string;
  /** The session that started this one (SessionStart hook calling_session_id). */
  callingSessionId?: string;
  /** Settings `toolResultModelChars`: tool results longer than this are cut for the model (default 120000). */
  toolResultModelChars?: number;
  /** Session tags (initialize_session / update_session_settings `tags`). */
  tags?: SessionTag[];
  /** Settings `modelUpgradePath`: model ids from weaker to stronger. Absent or exhausted: UpgradeModel is not offered. */
  modelUpgradePath?: string[];
  /** Prompt-cache key for this session's requests (a side-chat fork passes its parent's id; spec 17.4). Absent: the session id. */
  cacheKey?: string;
  /** Org `maxAutonomyLevel`: no setting, "always allow" option or spec option may go above it. */
  maxAutonomy?: AutonomyLevel;
  /** Settings `enableSecretScan`: ask before a `git commit` whose changes contain secrets (spec 5.5.1, 12.2, 13.4). */
  enableSecretScan?: boolean;
  /** Settings `compactionModelMode`: "current-model" always summarizes with the active model; "default" (or absent) uses `compactionModel` when set. */
  compactionModelMode?: "current-model" | "default";
}

/** Tool results longer than this many characters are cut for the model (head and tail); the full text stays in `content`. */
export const MODEL_RESULT_CHARS = 120_000;

/** The model-facing version of a long tool result (spec 12.1 model_content), or undefined when it fits. */
export function capForModel(content: string, limit: number): string | undefined {
  if (content.length <= limit) return undefined;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${content.slice(0, head)}\n[... ${content.length - limit} characters omitted from the middle; the user has the full result ...]\n${content.slice(content.length - tail)}`;
}

/** Responses API fields a model profile asks for. */
function openaiFields(p: ModelProfile): ModelRequest["openai"] {
  const o = { ...(p.textVerbosity ? { textVerbosity: p.textVerbosity } : {}), ...(p.serviceTier ? { serviceTier: p.serviceTier } : {}), ...(p.safetyIdentifier ? { safetyIdentifier: p.safetyIdentifier } : {}), ...(p.extendedCache ? { extendedCache: true } : {}), ...(p.acceptsNone ? { acceptsNone: true } : {}) };
  return Object.keys(o).length ? o : undefined;
}

/** Waits on one running Script before the turn is stopped (2 hours of 5-minute waits). */
export const SCRIPT_WAIT_STOP = 24;

function modeNotice(mode: ToolExecutionMode): string {
  return mode === "script_only"
    ? "<system-reminder>The model changed. From now on you reach tools only through Script (tools.Name({...}) inside a program, as the Script description shows), plus script_job for background jobs. The direct tools are no longer sent.</system-reminder>"
    : "<system-reminder>The model changed. From now on the tools (Read, Execute, Grep, Glob, Edit, Create) are available to call directly. Script and script_job are still available.</system-reminder>";
}

const specOnNotice = (canPropose: boolean) =>
  "<system-reminder>Spec mode is now on. Investigate with the read-only tools and change nothing: Edit and Create only work for plan files under .rigwell/specs/, and Execute only for read-only (low risk) commands. " +
  (canPropose ? "When your plan is ready, propose it with ExitSpecMode." : "Present your plan as your answer.") + "</system-reminder>";
const SPEC_OFF_NOTICE =
  "<system-reminder>Spec mode is off: the user switched the mode by hand. Nothing was approved. All tools are available again; follow the user's next message.</system-reminder>";

const AUTONOMY_RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

export function reasonForError(e: unknown): TurnReason {
  if (!(e instanceof ModelError)) return "error";
  switch (e.kind) {
    case "auth": return "model_authentication_failed";
    case "rate_limited": return "model_rate_limited";
    case "rejected": return "model_request_rejected";
    case "network": case "timeout": return "model_provider_unreachable";
    case "unavailable": case "overloaded": return "model_provider_unavailable";
    default: return "error";
  }
}

export class Session {
  readonly id: string;
  /** The prompt-cache key this session's requests carry. */
  get cacheKey(): string { return this.deps.cacheKey ?? this.id; }
  readonly cwd: string;
  settings: SessionSettings;
  messages: Message[];
  tokenUsage: TokenUsage;
  lastCallTokenUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  workingState: WorkingState = "idle";
  providerLock?: string;
  private readFiles = new Map<string, FileReadRecord>();
  private queue: QueuedUserMessage[] = [];
  private running = false;
  private abort?: AbortController;
  private activeTimeMs = 0;
  private currentRun?: Promise<void>;
  readonly jobs = new JobManager();
  private scripts: ScriptService;
  /** Notices to append before the next user message (e.g. the tool mode changed with the model). */
  private pendingNotices: string[] = [];
  private lastMode: ToolExecutionMode;
  private waitStreak = { jobId: "", count: 0 };
  /** Set by an inner Script call whose permission was refused in a way that ends the turn. */
  private pendingStop?: TurnReason;
  /** Deferred tools (MCP and others): announced by name, loaded with load_tools. */
  readonly deferred: DeferredRegistry;
  /** Builds every request and runs the cache monitor (spec §6). */
  readonly builder: RequestBuilder;
  /** Messages replaced by a compaction summary: kept for the UI, never sent to the model. */
  archived: Message[];
  private compactionAnchor?: string;
  private compactedOnce = false;
  /** File snapshots for rewind: the user message of the running turn is the boundary. */
  private snapRec?: SnapshotRecorder;
  private turnMessageId?: string;
  private callsSinceCompaction = 0;
  /** Context size after the last model call (tokens) and the message count it covered. */
  private lastCallContext?: { tokens: number; count: number };
  /** The model "auto" routing picked for the latest request. */
  private routed?: RouteChoice;
  // ---- Phase 5 wiring ----
  readonly hooks?: HookRunner;
  readonly instructions: InstructionLoader;
  readonly skills: SkillRegistry;
  private instrBlock: string | null = null;
  private skillToolOn = false;
  readonly mcp?: McpManager;
  private mcpNames = new Set<string>();
  /** Env exported by SessionStart hooks, passed to Execute. */
  private hookEnv: Record<string, string> = {};
  /** Resolves when the SessionStart hooks finished (turn 1 waits for it, at most 60 s). */
  private startup?: Promise<void>;
  private startupContext: string[] = [];
  /** A hook asked to end the turn (stop) or the agent (abort). */
  private halt?: { kind: "stop" | "abort"; message: string };
  private readonly startedAt = Date.now();
  private ended = false;
  private toolCalls = 0;
  /** Outcome of the latest finished turn (a subagent's report is its final text). */
  lastTurn?: { reason: TurnReason; text: string; structured?: unknown };
  private children = new Map<string, TokenUsage>();
  private lastChildUsage = zeroUsage();
  private turnChildUsage = zeroUsage();
  // ---- gap wave ----
  /** Prompts sent to the client and not answered yet, keyed by requestId (spec 3.1.5 pending lists). */
  private prompts = new Map<string, PendingPrompt>();
  private todos: TodoItem[];
  /** Mid-turn steering messages (queuePlacement end_of_loop), delivered after the next tool batch. */
  private steer: QueuedUserMessage[] = [];
  /** The structured-output format of the running turn, the answer recorded for it, and the bad attempts so far. */
  private format: OutputFormat | null = null;
  private structured?: { value: unknown };
  private invalidStructured = 0;
  private formatWasOn = false;
  private title: { value: string; manual: boolean; asked: boolean };
  private readonly svc: SessionServices;
  private tags: SessionTag[];
  private tagsSet = false;
  /** Result of the latest structured turn, for agent_turn_completed. */
  lastStructured?: unknown;

  constructor(private deps: SessionDeps, private host: SessionHost) {
    this.todos = deps.todos ? [...deps.todos] : [];
    this.tags = deps.tags ? [...deps.tags] : [];
    this.tagsSet = !!deps.tags;
    this.title = { value: deps.title?.value ?? "New Session", manual: deps.title?.manual ?? false, asked: !!deps.title?.manual || (deps.title?.value ?? "New Session") !== "New Session" };
    this.svc = {
      jobs: this.jobs,
      todos: { get: () => this.todos, set: (t) => this.setTodos(t) },
      askUser: (p, id) => this.askUser(p, id),
      setStructured: (v) => this.setStructured(v),
    };
    this.id = deps.id;
    this.cwd = deps.cwd;
    this.settings = { ...deps.settings };
    if (deps.maxAutonomy) this.settings.autonomyLevel = clampAutonomy(this.settings.autonomyLevel, deps.maxAutonomy);
    this.messages = deps.messages ?? [];
    this.tokenUsage = deps.tokenUsage ?? zeroUsage();
    this.lastMode = this.effectiveMode();
    this.archived = deps.archived ?? [];
    this.compactionAnchor = deps.compactionAnchorId;
    this.compactedOnce = !!deps.compactionAnchorId;
    this.deferred = new DeferredRegistry(deps.deferred);
    this.builder = new RequestBuilder(deps.log);
    this.instructions = new InstructionLoader({ cwd: deps.cwd, projectTrusted: deps.projectTrusted });
    this.instrBlock = this.instructions.load().block;
    this.skills = new SkillRegistry({ cwd: deps.cwd, includeBuiltins: !deps.disableBuiltinSkills, projectTrusted: deps.projectTrusted }).load();
    this.skillToolOn = this.skills.skillToolAvailable();
    attachSandbox(this.id, deps.autoRejectPermissionRequests || !host.requestPermission ? undefined : (p) => host.requestPermission!(p) as Promise<{ selectedOption: string }>);
    this.hooks = deps.hooksFor?.({
      sessionId: this.id, transcriptPath: deps.transcriptPath ?? "", notify: (n) => this.notify(n), permissionMode: () => this.permissionMode(),
    });
    if (deps.mcp) {
      this.mcp = new McpManager({
        cwd: deps.cwd, projectTrusted: deps.projectTrusted,
        onStatusChanged: (info) => {
          this.syncMcpTools();
          this.notify({ type: "mcp_status_changed", server: info, summary: this.mcp?.listServers().summary });
        },
      });
    }
    this.scripts = new ScriptService({
      sessionId: this.id, jobs: this.jobs, limits: deps.scriptLimits,
      toolNames: () => this.scriptTools().map((t) => t.name),
      host: {
        cwd: this.cwd,
        callTool: (name, input, meta) => this.callInner(name, input, meta),
        notify: (text) => this.notify({ type: "tool_progress_update", toolUseId: "script", toolName: "Script", update: { type: "status", text, timestamp: new Date().toISOString() } }),
        processExited: (message) => this.notify({ type: "session_process_exited", message, timestamp: new Date().toISOString() }),
      },
    });
    this.jobs.onFinished(() => { if (!this.running) this.kick(); });
  }

  /** Effective tool mode: the per-session override, else the model allowlist (spec §4.1). */
  effectiveMode(modelId: string = this.activeModelId()): ToolExecutionMode {
    if (this.deps.toolExecutionModeOverride) return this.deps.toolExecutionModeOverride;
    const list = this.deps.scriptToolModels ?? [];
    const model = this.deps.resolveModel(modelId);
    const apiName = model?.model;
    if (list.includes(modelId) || (apiName !== undefined && list.includes(apiName))) return "script_only";
    return resolveProfile(model, this.deps.profileSettings).toolExecutionMode;
  }

  /** The active model's profile (spec 4.1). */
  profile(): ModelProfile { return resolveProfile(this.currentModel(), this.deps.profileSettings); }

  /** True when a client can answer AskUser questions. */
  private canAsk(): boolean { return !!this.host.requestAskUser && !this.deps.autoRejectPermissionRequests && !this.deps.isChild; }

  private askObservers = new Set<(phase: "start" | "end") => void>();
  /** Told when AskUser starts waiting for the user and when the answer arrives (Missions planning: awaiting_input). */
  onAskUser(cb: (phase: "start" | "end") => void) { this.askObservers.add(cb); }
  private asking(phase: "start" | "end") { for (const cb of this.askObservers) { try { cb(phase); } catch { /* observer errors never stop the turn */ } } }

  /** Swaps the connection that owns this session (a client reconnected); pending prompts stay open. */
  setHost(h: SessionHost) { this.host = h; }

  get specMode(): boolean { return this.settings.interactionMode === "spec"; }

  /** The model this session asks now: in spec mode the spec model when one is set (spec 5.5.7). */
  activeModelId(): string {
    return this.specMode && this.settings.specModeModelId ? this.settings.specModeModelId : this.settings.modelId;
  }
  activeEffort(): ReasoningEffort {
    return this.specMode && this.settings.specModeReasoningEffort ? this.settings.specModeReasoningEffort : this.settings.reasoningEffort;
  }

  /** The permission mode name hooks see (spec 5.6). */
  permissionMode(): PermissionModeName {
    if (this.specMode) return "spec";
    return this.settings.autonomyLevel === "off" ? "off" : (`auto-${this.settings.autonomyLevel}` as PermissionModeName);
  }

  /** True when a client can answer prompts (not headless exec). */
  private get interactive(): boolean { return !!this.host.requestPermission && !this.deps.autoRejectPermissionRequests; }

  /** Task is offered at high autonomy or with skipped permissions, at depth 0 (spec 5.5.6), never in spec mode. */
  taskOffered(): boolean {
    const sub = this.deps.subagents;
    if (!sub || sub.depth >= sub.limits.maxDepth || this.specMode) return false;
    return this.settings.autonomyLevel === "high" || this.deps.skipPermissions;
  }
  private allowTaskInScripts(): boolean { return this.deps.allowSubagentsInScripts === true; }

  /** Core tools and Skill: what both direct calls and a Script can reach (autonomy gates apply). */
  private baseTools(): Tool[] {
    const ids = this.deps.toolIds;
    let t = this.deps.toolsFor({
      autonomy: this.settings.autonomyLevel, skipPermissions: this.deps.skipPermissions, specMode: this.specMode,
      fileEditProfile: this.profile().fileEditToolProfile, extraIds: [...(ids?.enabled ?? []), ...(ids?.additional ?? [])],
    });
    if (this.skillToolOn) t = [...t, skillTool(this.skills)];
    // The todo list is an interactive feature (spec 5.1).
    if (this.interactive && !this.deps.isChild) t = [...t, createTodoWriteTool()];
    if (this.deps.toolFilter) t = t.filter((x) => this.deps.toolFilter!.includes(x.name));
    return t;
  }

  /** Session tools that stay top level in both tool modes (spec 5.1): background job control, AskUser, StructuredOutput. */
  private sessionTools(): Tool[] {
    const t = [createTaskOutputTool(), createTaskStopTool()];
    if (this.canAsk()) t.push(createAskUserTool());
    if (this.format) t.push(createStructuredOutputTool(this.format.schema));
    return t;
  }

  /** initialize_session tool id lists: restrictToolIds is a hard allowlist; disabledToolIds removes tools. */
  private byIds(tools: Tool[]): Tool[] {
    if (this.deps.maxToolIds) tools = tools.filter((t) => this.deps.maxToolIds!.includes(t.name));
    const ids = this.deps.toolIds;
    if (!ids) return tools;
    let t = tools;
    if (ids.restrict) t = t.filter((x) => ids.restrict!.includes(x.name));
    if (ids.disabled?.length) t = t.filter((x) => !ids.disabled!.includes(x.name));
    return t;
  }

  private makeTaskTool(): Tool {
    return taskTool(agentCatalog(this.deps.subagents?.agents ?? []), (input, ctx) => this.runTaskTool(input, ctx));
  }

  /** What a Script binds: base tools, Task when allowed in Scripts, ToolSearch and load_tools (loaded deferred tools bind by name on call). */
  private scriptTools(): Tool[] {
    const task = this.taskOffered() && this.allowTaskInScripts() ? [this.makeTaskTool()] : [];
    return this.byIds([...this.baseTools(), ...this.sessionTools(), ...task, this.deferred.toolSearchTool(), this.deferred.loadToolsTool()]);
  }

  /** Makes a tool deferred: announced by name, schema sent only after load_tools. MCP tools register through here. */
  registerDeferredTool(tool: Tool) { this.deferred.register(tool); }
  unregisterDeferredTool(name: string) { this.deferred.unregister(name); }

  get isRunning() { return this.running; }

  /**
   * Tools sent to the model: Script and script_job always; the core tools, load_tools and call_tool too in
   * direct_only. Task (when offered) is direct unless Scripts may start subagents in script_only mode; ExitSpecMode
   * only while spec mode is on and a client can answer. Loading a deferred tool never changes this list (spec §6.2).
   */
  tools(): Tool[] {
    const script = [this.scripts.scriptTool(), this.scripts.jobTool()];
    const task = this.taskOffered() ? [this.makeTaskTool()] : [];
    const exit = [
      ...(this.specMode && this.interactive ? [exitSpecModeTool()] : []),
      ...(this.recommendMissionOffered() ? [recommendMissionTool()] : []),
      ...(this.nextUpgradeModel() && this.interactive && !this.deps.isChild ? [upgradeModelTool()] : []),
    ];
    if (this.effectiveMode() === "script_only") {
      return this.byIds([...script, ...this.sessionTools(), ...(this.allowTaskInScripts() ? [] : task), ...exit]);
    }
    return this.byIds([...this.baseTools(), ...this.sessionTools(), ...task, ...exit, this.deferred.loadToolsTool(), this.deferred.callToolTool(), ...script]);
  }

  private notify(n: Record<string, unknown>) {
    const redact = this.deps.redact;
    this.host.notify(redact ? (redactDeep(n, redact) as Record<string, unknown>) : n);
  }

  private setState(s: WorkingState) {
    if (this.workingState === s) return;
    this.workingState = s;
    this.notify({ type: "agent_working_state_changed", newState: s, ...(s === "idle" ? { backgroundWork: this.backgroundWork() } : {}) });
  }

  /** Background jobs (Execute, Task, Script) still running; reported on idle working-state notifications. */
  backgroundWork(): number { return this.jobs.list().filter((j) => j.status === "running").length; }

  settingsSnapshot(): Record<string, unknown> {
    return {
      ...this.settings, toolExecutionMode: this.effectiveMode(), availableAutonomyLevels: ["off", "low", "medium", "high"],
      sandbox: sandboxStatus(this.id, this.cwd),
      ...(this.routed ? { effectiveRouterModel: this.routedSettings(), routedModelId: this.routed.modelId, routedReasoningEffort: this.activeEffort() } : {}),
      ...(this.deps.toolIds?.restrict ? { restrictToolIds: this.deps.toolIds.restrict } : {}),
      ...(this.deps.toolIds?.enabled ? { enabledToolIds: this.deps.toolIds.enabled } : {}),
      ...(this.deps.toolIds?.disabled ? { disabledToolIds: this.deps.toolIds.disabled } : {}),
      ...(this.deps.toolIds?.additional ? { additionalToolIds: this.deps.toolIds.additional } : {}),
      ...(this.deps.systemPrompt ? { systemPrompt: this.deps.systemPrompt } : {}),
      ...(this.tags.length ? { tags: this.tags } : {}),
      ...(this.deps.structuredOutputFormat ? { structuredOutputFormat: this.deps.structuredOutputFormat } : {}),
      ...(this.checkEnabled !== undefined || this.deps.compactionThresholdCheckEnabled !== undefined ? { compactionThresholdCheckEnabled: this.checkEnabled ?? this.deps.compactionThresholdCheckEnabled } : {}),
    };
  }

  updateSettings(p: Partial<SessionSettings>, o: { quietModeChange?: boolean } = {}) {
    const causes: string[] = [];
    const modelBefore = this.activeModelId();
    const modeBefore = this.settings.interactionMode;
    if (p.autonomyLevel !== undefined && this.deps.maxAutonomy) p = { ...p, autonomyLevel: clampAutonomy(p.autonomyLevel, this.deps.maxAutonomy) };
    if (p.autonomyLevel !== undefined && p.autonomyLevel !== this.settings.autonomyLevel) causes.push("autonomy changed (tool list)");
    Object.assign(this.settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    if (this.activeModelId() !== modelBefore) causes.push("model changed");
    if (this.settings.interactionMode !== modeBefore) {
      causes.push("interaction mode changed (tool list)");
      if (!o.quietModeChange) this.pendingNotices.push(this.specMode ? specOnNotice(this.interactive) : SPEC_OFF_NOTICE);
    }
    if (causes.length) this.builder.monitor.expectBreak(causes.join(", "));
    const mode = this.effectiveMode();
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.pendingNotices.push(modeNotice(mode));
    }
    this.notify({ type: "settings_updated", settings: this.settingsSnapshot() });
    void this.persistSettings();
  }

  /** update_session_settings `tags`: replaces the session's tags. */
  setTags(tags: SessionTag[]) {
    this.tags = [...tags];
    this.tagsSet = true;
    this.notify({ type: "settings_updated", settings: this.settingsSnapshot() });
    void this.persistSettings();
  }

  /** update_session_settings tool id lists: the lists given replace the stored ones (null clears one). */
  setToolIds(ids: { restrict?: string[] | null; enabled?: string[] | null; disabled?: string[] | null; additional?: string[] | null }) {
    const next: NonNullable<SessionDeps["toolIds"]> = { ...(this.deps.toolIds ?? {}) };
    for (const k of ["restrict", "enabled", "disabled", "additional"] as const) {
      if (ids[k] === undefined) continue;
      if (ids[k] === null) delete next[k]; else next[k] = ids[k]!;
    }
    this.deps.toolIds = Object.keys(next).length ? next : undefined;
    this.builder.monitor.expectBreak("tool ids changed");
    this.notify({ type: "settings_updated", settings: this.settingsSnapshot() });
    void this.persistSettings();
  }

  /** Runs `fn` with some settings swapped in, then puts them back (the tool list is computed synchronously). */
  private preview<T>(o: ToolPreview, fn: () => T): T {
    const saved = { settings: { ...this.settings }, skip: this.deps.skipPermissions, sub: this.deps.subagents, ids: this.deps.toolIds, mode: this.deps.toolExecutionModeOverride };
    try {
      for (const k of ["modelId", "interactionMode", "autonomyLevel", "specModeModelId"] as const) if (o[k] !== undefined) (this.settings as any)[k] = o[k];
      if (o.skipPermissions !== undefined) this.deps.skipPermissions = o.skipPermissions;
      if (o.depth !== undefined && this.deps.subagents) this.deps.subagents = { ...this.deps.subagents, depth: o.depth };
      if (o.toolIds !== undefined) this.deps.toolIds = o.toolIds ?? undefined;
      if (o.mode) this.deps.toolExecutionModeOverride = o.mode;
      return fn();
    } finally {
      Object.assign(this.settings, saved.settings);
      this.deps.skipPermissions = saved.skip;
      this.deps.subagents = saved.sub;
      this.deps.toolIds = saved.ids;
      this.deps.toolExecutionModeOverride = saved.mode;
    }
  }

  /**
   * list_tools: every tool the session could offer under the given settings, with whether it is callable now
   * (offered directly or reachable from a Script, not removed by a tool id list) and where it comes from.
   * restrictToolIds is a hard allowlist and hides the rest; disabledToolIds keeps a tool listed but not allowed.
   */
  listToolInfo(o: ToolPreview = {}): { tool: Tool; currentlyAllowed: boolean; source: "native" | "mcp" }[] {
    const reach = () => [...this.tools(), ...this.scriptTools()];
    const ids = o.toolIds === undefined ? this.deps.toolIds : o.toolIds ?? undefined;
    const allowed = this.preview(o, reach);
    const allowedNames = new Set(allowed.map((t) => t.name));
    const wide = this.preview({ ...o, autonomyLevel: "high", skipPermissions: false, interactionMode: o.interactionMode === "spec" ? "spec" : "auto", mode: "direct_only", toolIds: ids ? { ...ids, disabled: undefined } : null }, reach);
    const byName = new Map<string, Tool>();
    for (const t of [...wide, ...allowed]) if (!byName.has(t.name)) byName.set(t.name, t);
    for (const n of this.deferred.names()) {
      const t = this.deferred.get(n);
      if (t && !byName.has(n) && (!ids?.restrict || ids.restrict.includes(n))) byName.set(n, t);
    }
    return [...byName.values()].map((tool) => {
      const deferred = this.deferred.get(tool.name) !== undefined;
      return {
        tool, source: this.mcp?.findTool(tool.name) ? "mcp" as const : "native" as const,
        currentlyAllowed: allowedNames.has(tool.name) || (deferred && !(ids?.disabled ?? []).includes(tool.name)),
      };
    });
  }

  private routedSettings() {
    const r = this.routed!;
    const eff = this.activeEffort();
    return { modelId: r.modelId, reasoningEffort: eff, reason: r.reason, fallbacks: r.fallbacks.map((f) => ({ modelId: f, reasoningEffort: eff })) };
  }

  /** Everything the UI shows: messages replaced by a summary, then the live history. */
  uiMessages(): Message[] { return [...this.archived, ...this.messages]; }

  /** This session's usage plus every subagent's (spec 12.1 inclusiveTokenUsage). */
  inclusiveUsage(): TokenUsage {
    let u = this.tokenUsage;
    for (const c of this.children.values()) u = addUsage(u, c);
    return u;
  }

  async persistSettings() {
    await this.deps.persistence.saveSettings({
      model: this.settings.modelId, reasoningEffort: this.settings.reasoningEffort,
      interactionMode: this.settings.interactionMode, autonomyLevel: this.settings.autonomyLevel,
      ...(this.settings.compactionModelId ? { compactionModelId: this.settings.compactionModelId } : {}),
      specModeModelId: this.settings.specModeModelId ?? null, specModeReasoningEffort: this.settings.specModeReasoningEffort ?? null,
      effectiveRouterModel: this.routed ? this.routedSettings() : undefined,
      toolExecutionMode: this.effectiveMode(), toolExecutionModeModelId: this.currentModel()?.id ?? this.activeModelId(),
      ...(this.deps.toolExecutionModeOverride ? { toolExecutionModeOverride: this.deps.toolExecutionModeOverride } : {}),
      ...(this.deps.allowSubagentsInScripts ? { allowSubagentsInScripts: true } : {}),
      assistantActiveTimeMs: this.activeTimeMs,
      tokenUsage: this.tokenUsage, inclusiveTokenUsage: this.inclusiveUsage(), lastCallTokenUsage: this.lastCallTokenUsage,
      ...(this.children.size ? { childInclusiveTokenUsageBySessionId: Object.fromEntries(this.children) } : {}),
      ...(this.providerLock ? { providerLock: this.providerLock, apiProviderLock: this.providerLock } : {}),
      loadedDeferredToolNames: this.deferred.state().loaded, announcedDeferredToolNames: this.deferred.state().announced,
      ...(this.deps.toolIds ? { toolIds: this.deps.toolIds } : {}),
      ...(this.deps.systemPrompt ? { systemPrompt: this.deps.systemPrompt } : {}),
      ...(this.tagsSet ? { tags: this.tags } : {}),
      ...(this.deps.structuredOutputFormat ? { structuredOutputFormat: this.deps.structuredOutputFormat } : {}),
      ...(this.deps.disableBuiltinSkills ? { disableBuiltinSkills: true } : {}),
      ...(this.compactionLimit ? { compactionTokenLimit: this.compactionLimit } : {}),
    });
  }

  /**
   * Starts what must not delay the first turn: the MCP servers (in parallel, not awaited) and the SessionStart hooks
   * (turn 1 waits for them, at most 60 s). Call once after construction.
   */
  start(source: "startup" | "resume" = "startup") {
    if (this.mcp) {
      try { this.mcp.startFromConfig(this.deps.mcp!.servers).catch((e) => this.deps.log?.(`[mcp] start failed: ${(e as Error)?.message ?? e}`)); }
      catch (e) { this.deps.log?.(`[mcp] start failed: ${(e as Error)?.message ?? e}`); }
    }
    if (this.hooks?.hasHooks() && !this.deps.isChild) {
      this.startup = (async () => {
        try {
          const r = await this.hooks!.sessionStart(source, {
            ...(this.deps.previousSessionId ? { previous_session_id: this.deps.previousSessionId } : {}),
            ...(this.deps.callingSessionId ? { calling_session_id: this.deps.callingSessionId } : {}),
          }, AbortSignal.timeout(60_000));
          Object.assign(this.hookEnv, r.envVars);
          if (r.additionalContext) this.startupContext.push(r.additionalContext);
          for (const m of r.systemMessages) await this.userNote(m);
        } catch (e) { this.deps.log?.(`[hooks] SessionStart failed: ${(e as Error)?.message ?? e}`); }
      })();
    }
  }

  /** Runs the SessionEnd hooks and stops the MCP servers. Once per session. */
  async end(reason = "other") {
    if (this.ended) return;
    this.ended = true;
    if (this.hooks?.hasHooks() && !this.deps.isChild) {
      await this.hooks.sessionEnd(reason, Date.now() - this.startedAt, this.messages.length).catch(() => {});
    }
    await this.mcp?.shutdown().catch(() => {});
    await detachSandbox(this.id).catch(() => {});
  }

  /** A note for the user only (hook system messages, notices): stored and sent as create_message, never shown to the model. */
  private async userNote(text: string) {
    const m: Message = { id: crypto.randomUUID(), role: "assistant", visibility: "user_only", content: [{ type: "text", text }] };
    await this.push(m);
    this.notify({ type: "create_message", message: m });
  }

  /** Accepts a user message. Returns at once; the turn runs in the background. */
  addUserMessage(
    text: string, messageId: string = crypto.randomUUID(), source?: string,
    opts: { content?: ContentBlock[]; placement?: "end_of_turn" | "end_of_loop" | "now"; outputFormat?: OutputFormat | null } = {},
  ) {
    const entry: QueuedUserMessage = {
      text, messageId, ...(source ? { source } : {}), ...(opts.content?.length ? { content: opts.content } : {}), ...(opts.outputFormat !== undefined ? { outputFormat: opts.outputFormat } : {}),
    };
    // end_of_loop while a turn runs is steering: it is delivered after the next tool call batch (spec 13.3).
    if (opts.placement === "now") { this.interrupt(); this.queue.unshift(entry); }
    else if (opts.placement === "end_of_loop" && this.running) this.steer.push(entry);
    else this.queue.push(entry);
    this.kick();
  }

  /** Messages accepted but not yet sent to the model (load_session queuedMessages). */
  queuedMessages(): QueuedUserMessage[] { return [...this.steer, ...this.queue]; }

  /** Prompts the client has not answered (load_session pendingPermissions / pendingAskUserRequests). */
  pendingPrompts(): PendingPrompt[] { return [...this.prompts.values()]; }

  /** An answer from a reconnected client resolves the original wait (keyed by requestId). */
  answerPrompt(requestId: string, answer: unknown): boolean {
    const p = this.prompts.get(requestId);
    if (!p) return false;
    p.resolve(answer);
    return true;
  }

  /** Sends a prompt to the client and waits. A client that disconnects leaves the prompt open for a later answer. */
  private prompt<T>(kind: PendingPrompt["kind"], requestId: string, params: Record<string, unknown>, send: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (!send) return resolve(fallback);
      this.prompts.set(requestId, { requestId, kind, params, fallback, resolve: (a) => { this.prompts.delete(requestId); resolve(a as T); } });
      send().then(
        (a) => this.prompts.get(requestId)?.resolve(a),
        (e) => { if ((e as { code?: number })?.code !== DISCONNECTED) this.prompts.get(requestId)?.resolve(fallback); },
      );
    });
  }

  /** Starts the turn loop unless it is already running. */
  private kick() {
    if (this.currentRun) return;
    const p = this.drain();
    this.currentRun = p;
    // A message queued after drain() made its last queue check but before currentRun was cleared would be stranded
    // (kick() saw a run in progress): start another run for it.
    void p.then(() => {
      if (this.currentRun === p) this.currentRun = undefined;
      if (!this.currentRun && this.queue.length) this.kick();
    });
  }

  /** Resolves when no turn is running. */
  async idle() { while (this.currentRun) await this.currentRun; }

  interrupt(clearQueued = false) {
    if (clearQueued) { this.queue.length = 0; this.steer.length = 0; }
    this.admissionAbort?.abort();
    this.abort?.abort();
    // An interrupted turn stops waiting on the client.
    for (const p of [...this.prompts.values()]) p.resolve(p.fallback);
  }

  private async drain() {
    this.running = true;
    try {
      for (;;) {
        // Steering that arrived too late for a tool batch becomes an ordinary next message.
        if (this.steer.length) this.queue.push(...this.steer.splice(0));
        while (this.queue.length) {
          const next = this.queue.shift()!;
          await this.runTurn(next.text, next.messageId, undefined, next);
          if (this.steer.length) this.queue.push(...this.steer.splice(0));
        }
        // A background job finished while the model was asleep: wake it with a reminder (spec §4.3).
        const wake = this.takeWake();
        if (!wake) break;
        await this.runTurn(wake, `wake-${crypto.randomUUID()}`, "llm_only");
      }
    } finally {
      this.running = false;
    }
  }

  /** Reminder text for background jobs that finished unseen, or null. Marks them seen. */
  private takeWake(): string | null {
    const done = this.jobs.unreported();
    if (!done.length) return null;
    const parts = done.map((j) => {
      j.reported = true;
      let body = JSON.stringify(j.report());
      if (body.length > 16_000) body = `${body.slice(0, 8_000)} ... [cut] ... ${body.slice(-8_000)}`;
      return `Background job ${j.id} (${j.kind}) finished with status ${j.status}. Result:\n${body}`;
    });
    return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
  }

  /** True while background jobs run or finished results have not reached the model. */
  hasBackgroundWork(): boolean {
    return this.jobs.running().length > 0 || this.jobs.unreported().length > 0;
  }

  /** Resolves when no turn runs and no background work is left (jobs finish, the wake turn runs). */
  async settled() {
    for (;;) {
      await this.idle();
      if (!this.hasBackgroundWork()) return;
      const live = this.jobs.running();
      if (!live.length) { this.kick(); continue; }
      await Promise.race(live.map((j) => j.done));
      await Promise.resolve();
    }
  }

  async stopBackgroundJobs() { await this.jobs.stopAll(); }

  private lastId(): string | null {
    const last = this.messages.at(-1);
    // The preamble after a compaction is not a transcript message: chain from the message the summary ends at.
    if (last?.id.startsWith("context-compact-")) return this.compactionAnchor ?? null;
    return last?.id ?? null;
  }

  private async push(msg: Message) {
    const parent = this.lastId();
    this.messages.push(msg);
    await this.deps.persistence.appendMessage(msg, parent);
  }

  private admissionAbort?: AbortController;
  private async runTurn(text: string, turnId: string, visibility?: "llm_only", entry?: QueuedUserMessage) {
    if (!this.deps.beforeTurn) return this.runAdmittedTurn(text, turnId, visibility, entry);
    const admission = new AbortController();
    this.admissionAbort = admission;
    let release: (() => void) | undefined;
    try {
      release = await this.deps.beforeTurn(admission.signal);
      if (!admission.signal.aborted) await this.runAdmittedTurn(text, turnId, visibility, entry);
    } catch (e) { if (!admission.signal.aborted) throw e; }
    finally { release?.(); if (this.admissionAbort === admission) this.admissionAbort = undefined; }
  }

  private async runAdmittedTurn(text: string, turnId: string, visibility?: "llm_only", entry?: QueuedUserMessage) {
    const started = Date.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let turnUsage = zeroUsage();
    let reason: TurnReason = "completed";
    let lastText = "";
    const toolCallsAtStart = this.toolCalls;
    this.halt = undefined;
    this.turnChildUsage = zeroUsage();
    this.turnMessageId = turnId;
    let blocked = false;
    let structuredNudged = false;
    let todoNudged = false;
    // Structured output (spec 3.1.5): the format for this turn, else the session's.
    this.format = entry && entry.outputFormat !== undefined ? entry.outputFormat : (this.deps.structuredOutputFormat ?? null);
    this.structured = undefined;
    this.invalidStructured = 0;
    const badSchema = this.format ? schemaProblem(this.format.schema) : null;
    if (badSchema) {
      blocked = true;
      reason = "structured_output_schema_invalid";
      this.format = null;
      this.notify({
        type: "error", message: `The structured output schema cannot be used: ${badSchema}`, errorType: "SessionError",
        timestamp: new Date().toISOString(), error: { name: "StructuredOutputSchemaInvalid", message: badSchema },
      });
    }
    if (!!this.format !== this.formatWasOn) {
      this.formatWasOn = !!this.format;
      this.builder.monitor.expectBreak("structured output tool");
    }

    try {
      await this.startup;
      this.startup = undefined;
      // UserPromptSubmit hooks (spec 5.6): may block the prompt, rewrite it, or add context.
      let prompt = text;
      let promptContext = "";
      if (!blocked && !visibility && this.hooks?.hasHooks() && !this.deps.isChild) {
        this.hooks.resetStop();
        const r = await this.hooks.userPromptSubmit(text, turnId, false, signal);
        for (const m of r.systemMessages) await this.userNote(m);
        if (r.blocked) {
          blocked = true;
          reason = "prompt_rejected";
          await this.userNote(`Your message was not sent: a hook blocked it. ${r.reason ?? ""}`.trim());
        } else {
          if (r.prompt !== undefined) prompt = r.prompt;
          promptContext = r.additionalContext;
        }
      }
      if (!blocked) {
        const first = !this.messages.some((m) => m.role === "user");
        if (first && !visibility && this.titleWanted()) void this.generateTitle(text);
        if (first) {
          const ctx = contextBlocks({
            cwd: this.cwd, interactionMode: this.settings.interactionMode, autonomy: this.settings.autonomyLevel,
            modelId: this.activeModelId(), shell: this.deps.shell, toolExecutionMode: this.effectiveMode(),
            instructions: this.instrBlock, skills: this.skills.contextBlock(this.currentModel()?.maxContextLimit),
            extra: this.startupContext.splice(0).map((t) => `<system-reminder>\nSessionStart hook:\n${t}\n</system-reminder>`),
            todos: this.todos, sandboxLabel: sandboxStatusLabel(sandboxStatus(this.id, this.cwd)),
          });
          await this.push({ id: `context-${turnId}`, role: "user", visibility: "llm_only", content: ctx.map((t) => ({ type: "text", text: t })) });
        }
        const notices = [...this.pendingNotices.splice(0)];
        // Instruction files found under folders the agent touched, and skills found there (appended, never edited in).
        const lazy = this.instructions.hasPending() ? this.instructions.takePending() : null;
        if (lazy) notices.push(lazy);
        notices.push(...this.startupContext.splice(0).map((t) => `<system-reminder>\nSessionStart hook:\n${t}\n</system-reminder>`));
        if (promptContext) notices.push(`<system-reminder>\nUserPromptSubmit hook:\n${promptContext}\n</system-reminder>`);
        for (const n of notices) {
          await this.push({ id: `notice-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: n }] });
        }
        for (const n of [...this.deferred.takeNotices(), this.deferred.announcement()]) {
          if (n) await this.push({ id: `deferred-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: n }] });
        }
        await this.push({ id: turnId, role: "user", ...(visibility ? { visibility } : {}), ...(entry?.source ? { userMessageSource: entry.source } : {}), content: entry?.content ?? [{ type: "text", text: prompt }] });
      }

      const repeat = new RepeatTracker();
      let emptyStreak = 0;
      while (!blocked) {
        if (signal.aborted) { reason = "cancelled"; break; }
        await this.maybeAutoCompact(signal);
        const messageId = crypto.randomUUID();
        const { model, done } = await this.callWithFallbacks(messageId, signal);
        // The final message is the source of truth; deltas were display only (a retried stream may have repeated them).
        const content: ContentBlock[] = done.content;
        this.builder.monitor.recordUsage(done.usage);
        turnUsage = addUsage(turnUsage, done.usage);
        this.tokenUsage = addUsage(this.tokenUsage, done.usage);
        this.deps.onUsage?.(model.id, done.usage);
        this.lastCallTokenUsage = { inputTokens: done.usage.inputTokens, cacheReadTokens: done.usage.cacheReadTokens, outputTokens: done.usage.outputTokens };
        this.providerLock ??= model.provider;
        await this.push({
          id: messageId, role: "assistant", content, modelId: model.id, apiProvider: model.provider,
          ...(this.routed && this.activeModelId() === AUTO_MODEL_ID ? { routerId: AUTO_MODEL_ID } : {}),
          reasoningEffort: this.activeEffort(), ...(done.openaiReasoning?.length ? { openaiReasoning: done.openaiReasoning } : {}),
          ...(done.openaiPhase ? { openaiPhase: done.openaiPhase } : {}),
        });
        this.lastCallContext = {
          tokens: done.usage.inputTokens + done.usage.cacheReadTokens + done.usage.cacheCreationTokens + done.usage.outputTokens,
          count: this.messages.length,
        };
        this.callsSinceCompaction++;
        for (const b of content) if (b.type === "tool_use") this.notify({ type: "tool_call", toolUse: { ...b } });
        this.notifyUsage();
        const texts = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
        if (texts) lastText = texts;

        const calls = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (signal.aborted && !calls.length) { reason = "cancelled"; break; }
        if (!calls.length && texts.trim() === "") {
          // No visible output (empty or thinking only): a one-word nudge each time, stop after emptyTurnStop in a row (spec 4.2).
          emptyStreak++;
          if (emptyStreak >= this.guards().emptyTurnStop) {
            await this.guardStop("guard_empty_stop_user", "guard_empty_stop_transcript", { COUNT: emptyStreak });
            break;
          }
          await this.push({ id: `nudge-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText("guard_empty_nudge") }] });
          continue;
        }
        emptyStreak = 0;
        if (!calls.length && this.format && !this.structured) {
          // The caller wants a structured answer: remind once, then end the turn with the matching reason.
          if (!structuredNudged && !signal.aborted) {
            structuredNudged = true;
            await this.push({ id: `nudge-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: "<system-reminder>The answer must be given by calling the StructuredOutput tool. Call it now with your final answer.</system-reminder>" }] });
            continue;
          }
          reason = this.invalidStructured ? "structured_output_invalid" : "structured_output_missing";
          this.notify({
            type: "error", errorType: "SessionError", timestamp: new Date().toISOString(),
            message: this.invalidStructured ? "The model never gave a structured answer that fits the schema." : "The model ended without giving the structured answer.",
            error: { name: reason, message: reason },
          });
          break;
        }
        if (!calls.length && !todoNudged && !visibility && !signal.aborted && this.todoNudgeWanted()) {
          // A todo list left incomplete at the end of the turn: one nudge (spec 4.2).
          todoNudged = true;
          await this.push({ id: `todo-suggest-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: todoNudgeText(this.todos) }] });
          continue;
        }
        if (!calls.length) {
          // Stop hooks (spec 5.6): may send the agent back to work (no cap on continuations, decision 4), end the turn, or abort.
          if (this.hooks?.hasHooks() && !this.deps.isChild && !signal.aborted && !visibility) {
            const r = await this.hooks.stop({ messageId, toolExecutionCount: this.toolCalls - toolCallsAtStart, elapsedMs: Date.now() - started }, signal);
            for (const m of r.systemMessages) await this.userNote(m);
            if (r.abort) { this.halt = { kind: "abort", message: r.abort }; reason = "error"; break; }
            if (r.stop) { this.halt = { kind: "stop", message: r.stop }; break; }
            if (r.continueWith) {
              await this.push({ id: `stop-hook-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: `<system-reminder>\nA Stop hook asks you to keep working:\n${r.continueWith}\n</system-reminder>` }] });
              continue;
            }
          }
          break;
        }

        const outcome = await this.runTools(calls, signal);
        // Notices about tools loaded during this batch, and tools that appeared or went away, ride in the same message.
        const extra = [...this.deferred.takeNotices(), this.deferred.announcement()]
          .filter((t): t is string => !!t).map((text) => ({ type: "text" as const, text }));
        for (const t of outcome.extras) extra.push({ type: "text", text: t });
        // Repeated identical batches with unchanged results: nudge, then stop (waits on a running Script have their own guard).
        const names = [...new Set(calls.map((c) => c.name))].join(", ");
        const isWait = calls.some((c) => c.name === "script_job" && c.input.action === "wait");
        const n = isWait ? (repeat.reset(), 0) : repeat.record(calls, outcome.results.map((r) => r.content));
        const g = this.guards();
        const vars = { TOOL_NAMES: names, COUNT: n, PLURAL: calls.length > 1 };
        if (n === g.repeatNudgeAt) extra.push({ type: "text", text: guardText("guard_repeat_nudge", vars) });
        await this.push({ id: crypto.randomUUID(), role: "user", content: [...outcome.results, ...extra] });
        if (outcome.stop) { reason = outcome.stop; break; }
        if (this.format && this.structured) break;
        if (this.format && this.invalidStructured >= 3) {
          reason = "structured_output_invalid";
          this.notify({ type: "error", errorType: "SessionError", timestamp: new Date().toISOString(), message: "The structured answer did not fit the schema after 3 tries.", error: { name: reason, message: reason } });
          break;
        }
        // Steering (queuePlacement end_of_loop): delivered right after the tool results (spec 13.3).
        for (const s of this.steer.splice(0)) {
          const m: Message = { id: s.messageId, role: "user", content: s.content ?? [{ type: "text", text: s.text }] };
          await this.push(m);
          this.notify({ type: "create_message", message: m });
        }
        if (n >= g.repeatStopAt) {
          await this.guardStop("guard_repeat_stop_user", "guard_repeat_stop_transcript", vars);
          break;
        }
        if (await this.scriptWaitGuard(calls)) break;
      }
    } catch (e) {
      if (signal.aborted) reason = "cancelled";
      else {
        reason = e instanceof OutputCycleError ? "error" : reasonForError(e);
        if (e instanceof OutputCycleError) {
          await this.push({ id: `cycle-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: `[Your previous response was cut by the harness: ${e.message} Do not repeat it; answer differently or ask the user.]` }] });
        }
        this.notify({
          type: "error", message: String((e as Error)?.message ?? e), errorType: "SessionError",
          timestamp: new Date().toISOString(), error: { name: (e as Error)?.name ?? "Error", message: String((e as Error)?.message ?? e) },
        });
      }
    }

    // A hook ended the turn (stop) or the agent (abort).
    if (this.halt) {
      const h = this.halt;
      this.halt = undefined;
      try {
        if (h.kind === "stop") await this.userNote(h.message);
        else {
          reason = "error";
          this.notify({ type: "error", message: h.message, errorType: "SessionError", timestamp: new Date().toISOString(), error: { name: "HookAbort", message: h.message } });
        }
      } catch { /* the turn still ends */ }
    }
    if (reason === "cancelled" && !this.deps.isChild) void this.hooks?.notification("idle_prompt", "The user stopped the agent.", turnId);

    const durationMs = Date.now() - started;
    this.activeTimeMs += durationMs;
    const answer = this.structured as { value: unknown } | undefined;
    this.lastStructured = answer?.value;
    this.lastTurn = { reason, text: lastText, ...(answer ? { structured: answer.value } : {}) };
    this.format = null;
    this.structured = undefined;
    this.notifyUsage();
    await this.deps.persistence.appendTurnOutcome({ turnId, reason, resultKind: this.lastTurn.structured !== undefined ? "structured" : lastText ? "text" : null });
    await this.persistSettings();
    if (reason === "completed" && this.interactive && !this.deps.isChild && !visibility) void this.hooks?.notification("idle_prompt", "The agent finished its turn and is waiting for you.", turnId);
    this.notify({
      type: "agent_turn_completed", reason, turnId, tokenUsage: turnUsage, cumulativeTokenUsage: this.inclusiveUsage(), durationMs,
      ...(this.lastTurn.structured !== undefined ? { structuredOutput: this.lastTurn.structured } : {}),
      ...(this.children.size ? { childTokenUsage: this.turnChildUsage, cumulativeChildTokenUsage: this.cumulativeChildUsage() } : {}),
    });
    this.setState("idle");
    this.abort = undefined;
  }

  private guards(model?: ModelConfig): GuardConfig {
    return resolveGuards(this.deps.guardSettings, model ?? this.currentModel());
  }

  /** The model a request would go to now: the session model, or for "auto" the routed pick (else the first candidate). */
  private currentModel(): ModelConfig | undefined {
    const id = this.activeModelId();
    if (id === AUTO_MODEL_ID && this.deps.router) {
      return this.deps.resolveModel(this.routed?.modelId ?? this.deps.router.candidates[0]?.model ?? "");
    }
    return this.deps.resolveModel(id);
  }

  /** The user-facing stop notice and the transcript text for the next turn (spec prompts.md section 7). */
  private async guardStop(userKey: keyof typeof PROMPT_TEXT, transcriptKey: keyof typeof PROMPT_TEXT, vars: Record<string, unknown>) {
    const notice: Message = { id: crypto.randomUUID(), role: "assistant", visibility: "user_only", content: [{ type: "text", text: guardText(userKey, vars) }] };
    await this.push(notice);
    this.notify({ type: "create_message", message: notice });
    await this.push({ id: crypto.randomUUID(), role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText(transcriptKey, vars) }] });
  }

  // ---------- model choice (auto routing, spec 4.5) ----------

  private async chooseModels(signal: AbortSignal): Promise<{ primary: ModelConfig; fallbacks: ModelConfig[] }> {
    const id = this.activeModelId();
    if (id === AUTO_MODEL_ID && this.deps.router) {
      const choice = await route(this.deps.router, this.messages, {
        resolveModel: this.deps.resolveModel,
        stream: (m, r) => this.deps.streamWithRetry(this.deps.createAdapter(m), r, { strategy: "no_retry" }),
      }, signal);
      const primary = this.deps.resolveModel(choice.modelId);
      if (!primary) throw new ModelError("rejected", `Auto routing picked an unknown model: ${choice.modelId}`);
      const changed = this.routed?.modelId !== choice.modelId;
      this.routed = choice;
      this.deps.log?.(`[router] ${choice.modelId} (${choice.reason}); scores ${JSON.stringify(choice.scores)}; fallbacks ${choice.fallbacks.join(", ") || "none"}`);
      if (changed) { this.notify({ type: "settings_updated", settings: this.settingsSnapshot() }); void this.persistSettings(); }
      return { primary, fallbacks: choice.fallbacks.map((f) => this.deps.resolveModel(f)).filter((m): m is ModelConfig => !!m) };
    }
    const model = this.deps.resolveModel(id);
    if (!model) throw new ModelError("rejected", `Unknown model: ${id}`);
    return { primary: model, fallbacks: [] };
  }

  /** Streams one answer from the chosen model; when the provider fails for good, the next fallback (routing only). */
  private async callWithFallbacks(messageId: string, signal: AbortSignal): Promise<{ model: ModelConfig; done: any }> {
    const { primary, fallbacks } = await this.chooseModels(signal);
    const order = [primary, ...fallbacks];
    for (let i = 0; i < order.length; i++) {
      const model = order[i]!;
      if (i > 0) this.builder.monitor.expectBreak(`router fallback to ${model.id}`);
      try {
        return { model, done: await this.streamOnce(model, messageId, signal) };
      } catch (e) {
        if (signal.aborted || !(e instanceof ModelError) || i === order.length - 1) throw e;
        this.deps.log?.(`[router] ${model.id} failed (${e.message}); trying ${order[i + 1]!.id}`);
      }
    }
    throw new ModelError("unknown", "no model could be called");
  }

  private async streamOnce(model: ModelConfig, messageId: string, signal: AbortSignal): Promise<any> {
    const g = this.guards(model);
    const req = { ...this.builder.build(this.buildInput(model, signal)), limits: { idleTimeoutMs: g.streamIdleTimeoutMs, hardLimitMs: g.hardResponseLimitMs } };
    this.setState("thinking");
    let partial = new Map<number, { id: string; name: string; json: string }>();
    let textBlocks = new Set<number>();
    let thinkingBlocks = new Set<number>();
    let streamText = "";
    let checked = 0;
    let done: any;
    for await (const ev of this.deps.streamWithRetry(this.deps.createAdapter(model), req, {
      strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs, passEmpty: true,
      onRetry: (attempt: number, why: string) => {
        // A retried stream starts over: what the failed attempt streamed is discarded (spec 4.2).
        partial = new Map(); textBlocks = new Set(); thinkingBlocks = new Set(); streamText = ""; checked = 0;
        this.notify({ type: "llm_retry", attempt, reason: why });
      },
    })) {
      switch (ev.type) {
        case "text_delta": {
          this.setState("streaming_assistant_message");
          textBlocks.add(ev.index);
          this.notify({ type: "assistant_text_delta", messageId, blockIndex: ev.index, textDelta: ev.text });
          streamText += ev.text;
          if (streamText.length - checked >= 400) {
            checked = streamText.length;
            const c = detectCycle(streamText, g.cycleMinChars, g.cycleMinRepeats);
            if (c) throw new OutputCycleError(c);
          }
          break;
        }
        case "thinking_delta":
          thinkingBlocks.add(ev.index);
          this.notify({ type: "thinking_text_delta", messageId, blockIndex: ev.index, textDelta: ev.text });
          break;
        case "tool_use_start":
          this.setState("streaming_assistant_message");
          partial.set(ev.index, { id: ev.id, name: ev.name, json: "" });
          this.notify({ type: "tool_execution_phase_changed", toolUseId: ev.id, toolName: ev.name, phase: "streaming_input" });
          this.notify({ type: "tool_call", toolUse: { type: "tool_use", id: ev.id, name: ev.name, input: {} } });
          break;
        case "tool_input_delta": {
          const p = partial.get(ev.index);
          if (p) {
            p.json += ev.partialJson;
            try {
              this.notify({ type: "tool_call", toolUse: { type: "tool_use", id: p.id, name: p.name, input: JSON.parse(p.json) } });
            } catch { /* partial JSON: wait for more */ }
          }
          break;
        }
        case "block_stop":
          if (textBlocks.has(ev.index)) this.notify({ type: "assistant_text_complete", messageId, blockIndex: ev.index });
          if (thinkingBlocks.has(ev.index)) this.notify({ type: "thinking_text_complete", messageId, blockIndex: ev.index });
          break;
        case "message_done":
          done = ev;
          break;
      }
    }
    if (!done) throw new ModelError("empty_response", "model stream ended without a final message");
    return done;
  }

  // ---------- compaction (spec 4.4) ----------

  private compactionCfg(): CompactionConfig { return resolveCompaction(this.deps.compaction); }

  /** Tokens at which automatic compaction starts: compactionTokenLimit, else the model's window minus the summary reserve. */
  compactionThreshold(): number {
    const m = this.currentModel();
    const per = this.deps.compactionTokenLimitPerModel;
    const own = m && per ? (per[m.id] ?? per[m.model]) : undefined;
    if (typeof own === "number" && own > 0) return own;
    if (this.compactionLimit) return this.compactionLimit;
    if (this.deps.compactionTokenLimit) return this.deps.compactionTokenLimit;
    // The summary reserve grows by the size of what compaction carries over: the todo list (spec 4.4).
    return (m?.maxContextLimit ?? 200_000) - this.compactionCfg().reserveTokens - this.carriedTokens();
  }

  /** Estimated tokens of the session state that compaction carries into the next context (the todo list). */
  carriedTokens(): number { return this.todos.length ? estimateTokens(renderTodoList(this.todos).length) : 0; }

  /** update_session_settings compactionTokenLimit / compactionThresholdCheckEnabled. */
  setCompaction(p: { limit?: number | null; checkEnabled?: boolean }) {
    if (p.limit !== undefined) this.compactionLimit = p.limit && p.limit > 0 ? p.limit : undefined;
    if (p.checkEnabled !== undefined) this.checkEnabled = p.checkEnabled;
  }
  private compactionLimit?: number;
  private checkEnabled?: boolean;

  /** Size of the next request: the last reported call plus what was added since; else an estimate of the whole prefix. */
  estimateContextTokens(): number {
    if (this.lastCallContext && this.lastCallContext.count <= this.messages.length) {
      return this.lastCallContext.tokens + messagesTokens(this.messages.slice(this.lastCallContext.count));
    }
    const model = this.currentModel();
    if (!model) return messagesTokens(this.messages);
    return Object.values(contextBreakdown(this.builder.preview(this.buildInput(model)))).reduce((a, b) => a + b, 0);
  }

  private async maybeAutoCompact(signal: AbortSignal): Promise<void> {
    if ((this.checkEnabled ?? this.deps.compactionThresholdCheckEnabled) === false) return;
    if (this.compactedOnce && this.callsSinceCompaction < this.guards().minCallsBetweenCompactions) return;
    if (this.estimateContextTokens() < this.compactionThreshold()) return;
    await this.compact({ reason: "automatic", signal });
  }

  /** compact_session: compacts in place (the session id stays), so newSessionId is this session's id. */
  async compactManual(o: { customInstructions?: string; mode?: "handoff" }): Promise<{ newSessionId: string; removedCount: number }> {
    if (this.running) throw new SessionBusyError();
    this.running = true;
    this.abort = new AbortController();
    try {
      const r = await this.compact({ reason: "manual", customInstructions: o.customInstructions, mode: o.mode, signal: this.abort.signal });
      return { newSessionId: this.id, removedCount: r.removedCount };
    } finally {
      this.abort = undefined;
      this.running = false;
      if (this.queue.length) this.kick();
    }
  }

  private compactionModel(): ModelConfig {
    const id = this.deps.compactionModelMode === "current-model" ? undefined : this.settings.compactionModelId;
    const m = (id && this.deps.resolveModel(id)) || this.currentModel();
    if (!m) throw new ModelError("rejected", `Unknown model: ${this.settings.modelId}`);
    return m;
  }

  /**
   * Summarizes the old part of the conversation and replaces it with the preamble message. The system prompt and tool
   * list are not touched; the loaded deferred tools are re-announced and recorded; the routed model is cleared.
   */
  async compact(o: { reason: "automatic" | "manual"; customInstructions?: string; mode?: "handoff"; signal?: AbortSignal }): Promise<{ removedCount: number }> {
    const cfg = this.compactionCfg();
    const before = this.workingState;
    this.setState("compacting_conversation");
    try {
      if (this.hooks?.hasHooks() && !this.deps.isChild) {
        const pc = await this.hooks.preCompact(o.reason === "manual" ? "manual" : "auto", {
          customInstructions: o.customInstructions, messageCount: this.messages.length, estimatedTokens: this.estimateContextTokens(),
        });
        if (pc.cancel) throw new Error(`Compaction was cancelled by a PreCompact hook${pc.reason ? `: ${pc.reason}` : ""}`);
      }
      const context = this.refreshedContext(contextTextBlocks(this.messages));
      const reinject = this.deferred.reinjection();
      const fixed = messagesTokens([preambleMessage("x", [...context, ...(reinject ? [reinject] : [])])]);
      const keepBudget = Math.max(0, cfg.postCeilingTokens - cfg.targetTokens - fixed);
      const cut = o.mode === "handoff" ? this.messages.length : pickCut(this.messages, keepBudget, cfg.keepRecentTurns);
      const removed = this.messages.slice(0, cut);
      const real = removed.filter((m) => !m.id.startsWith("context-compact-"));
      if (!real.length) throw new Error("Nothing to compact yet.");
      const model = this.compactionModel();
      const g = this.guards(model);
      const built = buildSummarizerRequest({
        model, sessionId: this.id, messages: removed, cfg, customInstructions: o.customInstructions,
        limits: { idleTimeoutMs: g.streamIdleTimeoutMs, hardLimitMs: g.hardResponseLimitMs },
      });
      this.deps.log?.(`[compaction] ${o.reason}: summarizing ${real.length} messages (${built.transcriptChars} chars) with ${model.id}; summarizer limit ${built.limit} tokens, max_tokens ${built.req.maxOutputTokens}`);
      const stream = this.deps.streamWithRetry(this.deps.createAdapter(model), { ...built.req, signal: o.signal }, {
        strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs,
        onRetry: (attempt: number, why: string) => this.notify({ type: "llm_retry", attempt, reason: why }),
      });
      const { text, usage } = await collectSummary(stream);
      if (!text) throw new ModelError("empty_response", "The summarizer returned no text.");
      if (usage) {
        this.tokenUsage = addUsage(this.tokenUsage, usage);
        this.deps.onUsage?.(model.id, usage);
        this.notifyUsage();
      }

      const anchor = real.at(-1)!;
      const anchorIndex = this.archived.length + this.messages.indexOf(anchor) - (this.messages[0]?.id.startsWith("context-compact-") ? 1 : 0);
      const blocks = preambleBlocks(text, context, reinject ? [reinject] : []);
      const preambleId = `context-compact-${crypto.randomUUID()}`;
      const record: CompactionRecord = {
        type: "compaction_state", id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        summaryText: text, summaryTokens: estimateTokens(text.length), summaryKind: "llm_summary",
        anchorMessage: { id: anchor.id, index: anchorIndex }, removedCount: real.length,
        loadedDeferredToolNames: this.deferred.loadedNames(), retainedSkills: [], retainedImages: [],
        reason: o.reason, preambleMessageId: preambleId, preambleBlocks: blocks,
      };
      await this.deps.persistence.appendCompaction?.(record);
      this.archived.push(...real);
      this.messages = [preambleMessage(preambleId, blocks), ...this.messages.slice(cut)];
      this.compactionAnchor = anchor.id;
      // Instruction files and dynamic skills are discoverable again (the preamble carries the session-start ones).
      this.instructions.afterCompaction();
      this.skills.afterCompaction();
      this.lastCallContext = undefined;
      this.routed = undefined; // the routed pick is cleared: routing runs again (spec 4.5)
      this.callsSinceCompaction = 0;
      this.compactedOnce = true;
      this.builder.monitor.expectBreak("compaction");
      this.notify({ type: "session_compacted", summaryId: record.id, removedCount: real.length, visibleBoundaryMessageId: this.messages[1]?.id ?? null });
      await this.persistSettings();
      if (this.hooks?.hasHooks() && !this.deps.isChild) {
        void this.hooks.sessionStart("compact").then((r) => { if (r.additionalContext) this.startupContext.push(r.additionalContext); }).catch(() => {});
      }
      return { removedCount: real.length };
    } finally {
      this.setState(before === "compacting_conversation" ? "idle" : before);
    }
  }

  /** The context blocks to re-inject after a compaction: the skills block is rebuilt so skills found during the session are in it. */
  private refreshedContext(inBlocks: string[]): string[] {
    // The todo list is carried: the todos block is rebuilt from the current list.
    const todoAt = inBlocks.findIndex((b) => b.startsWith("<todos>"));
    const blocks = todoAt >= 0 ? inBlocks.map((b, i) => (i === todoAt ? todosBlock(this.todos) : b)) : inBlocks;
    const fresh = this.skills.contextBlock(this.currentModel()?.maxContextLimit);
    const at = blocks.findIndex((b) => b.startsWith("<skills>"));
    if (at >= 0) return fresh ? blocks.map((b, i) => (i === at ? fresh : b)) : blocks.filter((_, i) => i !== at);
    if (!fresh) return blocks;
    const session = blocks.findIndex((b) => b.startsWith("<session>"));
    return session >= 0 ? [...blocks.slice(0, session), fresh, ...blocks.slice(session)] : [...blocks, fresh];
  }

  private buildInput(model: ModelConfig, signal?: AbortSignal) {
    const prof = resolveProfile(model, this.deps.profileSettings);
    return {
      model, sessionId: this.id, mode: this.effectiveMode(), tools: this.tools(), messages: this.messages,
      reasoningEffort: this.activeEffort(), signal,
      extraSystem: [...(prof.promptVariant ? [prof.promptVariant] : []), ...(this.deps.extraSystem ?? [])],
      systemPrompt: this.deps.systemPrompt, toolDescriptions: prof.toolDescriptionOverrides, cacheStrategy: prof.cache.strategy, openai: openaiFields(prof),
      ...(this.deps.cacheKey ? { cacheKey: this.deps.cacheKey } : {}),
    };
  }

  /** get_context_stats extras: breakdown by category (estimated tokens) and the cache monitor numbers. */
  contextStats(limit: number) {
    const model = this.currentModel();
    const used = this.lastCallTokenUsage.inputTokens + this.lastCallTokenUsage.cacheReadTokens + this.lastCallTokenUsage.outputTokens;
    const breakdown = model ? contextBreakdown(this.builder.preview(this.buildInput(model))) : undefined;
    const estimated = breakdown ? Object.values(breakdown).reduce((a, b) => a + b, 0) : 0;
    const now = used || estimated;
    return {
      used: now, remaining: Math.max(0, limit - now), limit, accuracy: used ? "exact" : "estimated",
      updatedAt: new Date().toISOString(),
      ...(breakdown ? { breakdown, breakdownAccuracy: "estimated" } : {}),
      cache: this.builder.monitor.stats(),
    };
  }

  /** warmup_cache: sends a priming request for the current prefix. Best effort; never throws. */
  async warmupCache(): Promise<void> {
    if (this.running) return;
    const model = this.currentModel();
    if (!model) return;
    try {
      const input = this.buildInput(model);
      const req = this.builder.buildWarmup(input);
      if (!req.messages.length) {
        req.messages = [{ id: "warmup", role: "user", content: [{ type: "text", text: "<system-reminder>Cache warm-up. Reply with one word.</system-reminder>" }] }];
      }
      for await (const ev of this.deps.streamWithRetry(this.deps.createAdapter(model), req, { strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs })) {
        if (ev.type === "message_done") {
          this.tokenUsage = addUsage(this.tokenUsage, ev.usage);
          this.deps.onUsage?.(model.id, ev.usage);
          this.deps.log?.(`[cache] warmup: read ${ev.usage.cacheReadTokens}, created ${ev.usage.cacheCreationTokens}, uncached ${ev.usage.inputTokens}`);
        }
      }
      this.notifyUsage();
    } catch (e) {
      this.deps.log?.(`[cache] warmup failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private async runTools(calls: ToolUseBlock[], signal: AbortSignal): Promise<{ results: ToolResultBlock[]; stop?: TurnReason; extras: string[] }> {
    const results: ToolResultBlock[] = [];
    const extras: string[] = [];
    const tools = new Map(this.tools().map((t) => [t.name, t]));
    // Several calls that need approval get one prompt for the whole batch (spec 5.5.5).
    const batch = signal.aborted ? undefined : await this.askBatch(calls, tools);
    let stop: TurnReason | undefined = batch?.cancelled ? "permission_rejected" : undefined;
    for (const call of calls) {
      const phase = (p: string) => this.notify({ type: "tool_execution_phase_changed", toolUseId: call.id, toolName: call.name, phase: p });
      const finish = (rawContent: string, isError: boolean, executed: boolean, images?: ImageBlock[]) => {
        const content = this.deps.redact ? this.deps.redact(rawContent) : rawContent;
        const cut = capForModel(content, this.deps.toolResultModelChars ?? MODEL_RESULT_CHARS);
        results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}), ...(images?.length ? { images } : {}), ...(cut !== undefined ? { modelContent: cut } : {}) });
        this.notify({ type: "tool_result", toolUseId: call.id, messageId: `tool-result-${call.id}`, content, isError, ...(images?.length ? { images } : {}) });
        phase(executed ? "settled_after_execution" : "settled_without_execution");
      };
      phase("queued");
      if (batch?.cancelled && batch.ids.has(call.id)) {
        finish(`The user rejected this tool call and stopped the turn.${batch.comment ? ` [Comment] ${batch.comment}` : ""}`, true, false);
        continue;
      }
      if (stop || signal.aborted) { finish("Not run: the turn was stopped before this call.", true, false); continue; }
      const tool = tools.get(call.name);
      if (!tool) { finish(`Unknown tool: ${call.name}. Use one of: ${[...tools.keys()].join(", ")}.`, true, false); continue; }

      // PreToolUse hooks run before the permission gate (spec 5.6).
      let input = call.input;
      let skipAsk = false;
      let unrated = false;
      if (this.hooks?.hasHooks()) {
        const pre = await this.hooks.preToolUse(call.name, call.input, call.id, signal);
        if (pre.additionalContext) extras.push(hookContext("PreToolUse", call.name, pre.additionalContext));
        for (const m of pre.systemMessages) await this.userNote(m);
        if (pre.decision === "abort") {
          this.halt = { kind: "abort", message: pre.reason ?? "aborted by a hook" };
          finish(`Not run: a hook aborted the agent. ${pre.reason ?? ""}`.trim(), true, false);
          stop = "error";
          continue;
        }
        if (pre.decision === "stop") {
          this.halt = { kind: "stop", message: pre.reason ?? "stopped by a hook" };
          finish("Not run: a hook stopped the turn.", true, false);
          stop = "completed";
          continue;
        }
        if (pre.decision === "deny") { finish(`Blocked by a hook: ${pre.reason ?? "no reason given"}`, true, false); continue; }
        if (pre.updatedInput) {
          input = { ...pre.updatedInput };
          // A rewritten command is judged as unrated, so it asks, unless the hook keeps the model's rating (spec 5.5.2).
          if (call.name === "Execute" && input.command !== call.input.command && !pre.preserveRiskLevel) {
            delete input.riskLevel;
            delete input.riskReason;
            unrated = true;
          }
        }
        skipAsk = pre.decision === "allow";
      }

      if (call.name === "ExitSpecMode") {
        phase("executing");
        const out = await this.exitSpecMode(call, input, signal);
        finish(out.content, !!out.isError, true);
        if ((out.data as { handoff?: unknown } | undefined)?.handoff) stop = "spec_handoff";
        continue;
      }
      if (call.name === "RecommendMission" || call.name === "UpgradeModel") {
        phase("executing");
        const out = call.name === "RecommendMission" ? await this.recommendMission(call, input) : await this.upgradeModel(call, input);
        finish(out.content, !!out.isError, true);
        continue;
      }

      let d = this.gate(call.name, input, unrated);
      if (skipAsk && (d.decision === "ask" || d.decision === "missing_risk")) d = { decision: "allow", reason: "allowed by a hook" };
      if (d.decision === "block" || d.decision === "missing_risk") { finish(d.message, true, false); continue; }
      if (d.decision === "ask" && !batch?.approved.has(call.id)) {
        const asked = await this.askPermission(call, d);
        const verdict = asked.verdict;
        const said = asked.comment ? ` [Comment] ${asked.comment}` : "";
        if (verdict === "rejected") { finish(`The user rejected this tool call. Do not retry it; change your approach or ask the user.${said}`, true, false); continue; }
        if (verdict === "cancel") { finish(`The user rejected this tool call and stopped the turn.${said}`, true, false); stop = "permission_rejected"; continue; }
        if (verdict === "no_approver") {
          finish("This call needs approval, and this run cannot ask for it.", true, false);
          stop = "no_approver_available";
          this.notify({
            type: "error", errorType: "SessionError", timestamp: new Date().toISOString(),
            message: `Tool call ${call.name} needs approval at autonomy "${this.settings.autonomyLevel}". Re-run with a higher --auto level (low, medium, high) or with --skip-permissions-unsafe.`,
          });
          continue;
        }
      }
      const scanned = await this.secretScanGate(call, input);
      if (scanned) { finish(scanned, true, false); continue; }
      phase("executing");
      this.setState("executing_tool");
      let out: ToolOutput | undefined;
      // Long tools tell the client they are alive (tool_execution_heartbeat, spec 3.1.7).
      const beat = setInterval(() => this.notify({ type: "tool_execution_heartbeat", toolUseId: call.id, toolName: call.name }), this.deps.heartbeatMs ?? 10_000);
      try {
        this.toolCalls++;
        out = await tool.run(input, {
          ...this.toolContext(signal), toolUseId: call.id, jobs: this.jobs, snapshots: this.snapshotHooks(call.id),
          onProgress: (p) => this.notify({ type: "tool_progress_update", toolUseId: call.id, toolName: call.name, update: { ...p, timestamp: new Date().toISOString() } }),
        });
        finish(out.content, !!out.isError, true, out.images);
        if (!out.isError) this.noteTouched(call.name, input);
      } catch (e) {
        finish(`Tool failed: ${(e as Error)?.message ?? e}`, true, true);
      } finally {
        clearInterval(beat);
      }
      // PostToolUse runs once per call, so once for an outer Script (decision 3); skipped when the user cancelled.
      if (out && this.hooks?.hasHooks() && !signal.aborted) {
        const post = await this.hooks.postToolUse(call.name, input, { content: out.content, isError: !!out.isError }, call.id, signal);
        for (const m of post.systemMessages) await this.userNote(m);
        if (post.feedback) extras.push(hookContext("PostToolUse feedback", call.name, post.feedback));
        if (post.additionalContext) extras.push(hookContext("PostToolUse", call.name, post.additionalContext));
        if (post.abort) { this.halt = { kind: "abort", message: post.abort }; stop = "error"; }
        else if (post.stop) { this.halt = { kind: "stop", message: post.stop }; stop = "completed"; }
      }
      if (this.pendingStop) { stop = this.pendingStop; this.pendingStop = undefined; }
    }
    return { results, stop, extras };
  }

  /** A file tool touched `path`: look for instruction files and skills in the folders on the way (spec 12.2, 5.8). */
  /** Snapshot hooks for Edit/Create (rewind). Absent for child sessions and when RIGWELL_SNAPSHOTS=off. */
  private snapshotHooks(toolUseId: string): ToolContext["snapshots"] {
    const turn = this.turnMessageId;
    if (!turn || this.deps.isChild || process.env.RIGWELL_SNAPSHOTS === "off") return undefined;
    this.snapRec ??= new SnapshotRecorder(this.id, this.deps.log);
    return this.snapRec.hooks(turn, this.archived.length + this.messages.findIndex((m) => m.id === turn), toolUseId);
  }

  private noteTouched(tool: string, input: Record<string, unknown>) {
    if (!["Read", "Edit", "Create"].includes(tool) || typeof input.path !== "string" || !input.path) return;
    try {
      const abs = resolve(this.cwd, input.path.startsWith("~/") ? join(homedir(), input.path.slice(2)) : input.path);
      this.instructions.discoverForPath(abs);
      const added = this.skills.discoverForPath(abs);
      if (added.length) {
        const t = renderAdditionalSkills(added);
        if (t) this.pendingNotices.push(t);
        this.skills.markAnnounced(added);
      }
    } catch (e) { this.deps.log?.(`[discovery] ${(e as Error)?.message ?? e}`); }
  }

  /** Permission decision for one call. Deferred tools (MCP and others) ask unless they only read or are remembered; call_tool is judged by its target. */
  private gate(name: string, input: Record<string, unknown>, unrated = false): PermissionDecision {
    // Skill and Task need no approval of their own: what the subagent does is gated in its own session.
    if (name === "Skill" || name === "Task") return { decision: "allow" };
    let target: Tool | undefined;
    let args = input;
    if (name === "call_tool") {
      const r = this.deferred.resolveCallable(String(input.name ?? ""));
      if (typeof r === "string") return { decision: "allow" }; // the tool call itself returns the error text
      target = r;
      args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>;
    } else if (!this.scriptTools().some((t) => t.name === name) && this.deferred.get(name)) {
      target = this.deferred.get(name);
    }
    if (target) {
      if (this.deps.skipPermissions) return { decision: "allow" };
      const info = this.mcp?.findTool(target.name);
      if (info) {
        // MCP tool: ask unless remembered (spec 5.5.4, 5.5.5).
        if (isMcpAllowed(this.cwd, info)) return { decision: "allow", reason: "remembered MCP tool" };
        return {
          decision: "ask", confirmationType: "mcp_tool", impactLevel: "high", alwaysLevel: null,
          details: { toolName: info.llmName, serverName: info.server, actualToolName: info.tool, impactLevel: "high", input: args },
          reason: `MCP tool ${info.llmName}`,
          options: [
            { label: "Yes, allow once", value: "proceed_once" },
            { label: `Yes, and always allow ${info.llmName}`, value: "proceed_always_tools" },
            { label: `Yes, and always allow all ${info.server} tools`, value: "proceed_always_server" },
            { label: "No, cancel", value: "cancel" },
          ],
        };
      }
      if (target.category === "read") return { decision: "allow" };
      return {
        decision: "ask", confirmationType: "exec", impactLevel: "high", alwaysLevel: null,
        details: { toolName: target.name, input: args }, reason: `Deferred tool ${target.name}`,
      };
    }
    const pctx = {
      autonomy: this.settings.autonomyLevel, interactionMode: this.settings.interactionMode,
      skipPermissions: this.deps.skipPermissions, lists: this.deps.lists, cwd: this.cwd,
    };
    if (unrated && name === "Execute") {
      const note = "A hook rewrote this command, so the model's risk rating no longer applies.";
      const d = this.deps.decide(name, { ...input, riskLevel: "high", riskReason: note }, pctx);
      // Only a risk-based allow is turned into a question; lists and skipped permissions keep their answer.
      if (d.decision === "allow" && !d.reason) {
        const command = String(input.command ?? "");
        return { decision: "ask", confirmationType: "exec", details: { fullCommand: command, command, impactLevel: "high", riskLevelReason: note }, impactLevel: "high", alwaysLevel: "high", reason: note };
      }
      return d;
    }
    return this.deps.decide(name, input, pctx);
  }

  /**
   * One tool call made from inside a Script. It takes the same path as a direct call: permission
   * gate (a prompt per call that needs one), execution, notifications and transcript records.
   * Throws ToolCallError when the call is refused; the Script sees a rejected promise.
   */
  private async callInner(
    name: string, inputIn: Record<string, unknown>,
    meta: { runId: string; n: number; outerId: string; signal: AbortSignal; foreground: boolean },
  ): Promise<ToolOutput> {
    const id = `${meta.runId}-${meta.n}`;
    let input = inputIn;
    const use: ToolUseBlock = { type: "tool_use", id, name, input, scriptExecution: { runId: meta.runId, outerToolUseId: meta.outerId } };
    this.notify({ type: "tool_call", toolUse: use });
    await this.push({ id: `repl-tool-call:${id}`, role: "assistant", visibility: "user_only", content: [use] });
    const finish = async (content: string, isError: boolean) => {
      this.notify({ type: "tool_result", toolUseId: id, messageId: `repl-tool-result:${id}`, content, isError });
      await this.push({ id: `repl-tool-result:${id}`, role: "user", visibility: "user_only", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] });
    };
    const refuse = async (message: string, errName = "Error"): Promise<never> => {
      await finish(message, true);
      throw new ToolCallError(message, errName);
    };
    let tool = this.scriptTools().find((t) => t.name === name);
    if (!tool) {
      // A deferred tool: callable once loaded (tools.server.tool is the name server__tool).
      if (!this.deferred.get(name) && !this.deferred.isLoaded(name)) {
        return refuse(`Unknown tool: ${name}. Available in a Script: ${this.scriptTools().map((t) => t.name).join(", ")}, plus deferred tools after tools.load_tools.`);
      }
      const r = this.deferred.resolveCallable(name);
      if (typeof r === "string") return refuse(r);
      tool = r;
    }
    if (name === "Execute" && input.background === true) {
      return refuse("background is not available inside a Script. Start the whole Script with //@background instead.");
    }
    // PreToolUse hooks also judge calls made inside a Script (spec 5.6 "Hooks and Scripts").
    let skipAsk = false;
    let unrated = false;
    if (this.hooks?.hasHooks()) {
      const pre = await this.hooks.preToolUse(name, input, id, meta.signal);
      for (const m of pre.systemMessages) await this.userNote(m);
      if (pre.decision === "deny") return refuse(`PermissionDenied: this ${name} call was rejected by policy (hook): ${pre.reason ?? "no reason given"}`, "PermissionDenied");
      if (pre.decision === "stop" || pre.decision === "abort") {
        const kind = pre.decision;
        if (meta.foreground && this.abort && !this.abort.signal.aborted) {
          this.halt = { kind, message: pre.reason ?? `${kind} requested by a hook` };
          this.pendingStop = kind === "abort" ? "error" : "completed";
          this.abort.abort();
        }
        return refuse(`PermissionDenied: this ${name} call was rejected by policy (hook ${kind}): ${pre.reason ?? ""}`.trim(), "PermissionDenied");
      }
      if (pre.updatedInput) {
        input = { ...pre.updatedInput };
        if (name === "Execute" && input.command !== inputIn.command && !pre.preserveRiskLevel) { delete input.riskLevel; delete input.riskReason; unrated = true; }
      }
      skipAsk = pre.decision === "allow";
    }
    let d = this.gate(name, input, unrated);
    if (skipAsk && (d.decision === "ask" || d.decision === "missing_risk")) d = { decision: "allow", reason: "allowed by a hook" };
    if (d.decision === "block") return refuse(d.message, "PermissionDenied");
    if (d.decision === "missing_risk") return refuse(d.message);
    if (d.decision === "ask") {
      const asked = await this.askPermission(use, d);
      const verdict = asked.verdict;
      const said = asked.comment ? ` [Comment] ${asked.comment}` : "";
      if (verdict === "rejected") return refuse(`PermissionDenied: the user rejected this tool call. Do not retry it; change your approach or ask the user.${said}`, "PermissionDenied");
      if (verdict === "cancel" || verdict === "no_approver") {
        if (meta.foreground && this.abort && !this.abort.signal.aborted) {
          this.pendingStop = verdict === "cancel" ? "permission_rejected" : "no_approver_available";
          if (verdict === "no_approver") {
            this.notify({
              type: "error", errorType: "SessionError", timestamp: new Date().toISOString(),
              message: `Tool call ${name} (inside a Script) needs approval at autonomy "${this.settings.autonomyLevel}". Re-run with a higher --auto level (low, medium, high) or with --skip-permissions-unsafe.`,
            });
          }
          this.abort.abort();
        }
        return refuse(verdict === "cancel"
          ? `PermissionDenied: the user rejected this tool call and stopped the turn.${said}`
          : "PermissionDenied: this call needs approval, and this run cannot ask for it.", "PermissionDenied");
      }
    }
    const scanned = await this.secretScanGate(use, input);
    if (scanned) return refuse(scanned, "PermissionDenied");
    try {
      this.toolCalls++;
      const out = await tool.run(input, { ...this.toolContext(meta.signal), toolUseId: id, snapshots: this.snapshotHooks(id) });
      await finish(out.content, !!out.isError);
      if (!out.isError) this.noteTouched(name, input);
      return out;
    } catch (e) {
      return refuse(`Tool failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Spec §4.2: repeats that are only waits on one running Script get no nudge and stop at 24.
   * Returns true when the turn was stopped.
   */
  private async scriptWaitGuard(calls: ToolUseBlock[]): Promise<boolean> {
    const first = calls[0];
    const jobId = first?.name === "script_job" && first.input.action === "wait" ? String(first.input.job_id ?? "") : "";
    const onlyWaits = jobId !== "" && calls.every((c) => c.name === "script_job" && c.input.action === "wait" && c.input.job_id === jobId);
    if (!onlyWaits || this.jobs.get(jobId)?.status !== "running") { this.waitStreak = { jobId: "", count: 0 }; return false; }
    this.waitStreak = this.waitStreak.jobId === jobId ? { jobId, count: this.waitStreak.count + 1 } : { jobId, count: 1 };
    if (this.waitStreak.count < SCRIPT_WAIT_STOP) return false;
    const vars = { JOB_ID: jobId, COUNT: this.waitStreak.count, HOURS: Math.round((this.waitStreak.count * 5) / 60) };
    this.waitStreak = { jobId: "", count: 0 };
    const user = guardText("guard_scriptwait_stop_user", vars);
    const notice: Message = { id: crypto.randomUUID(), role: "assistant", visibility: "user_only", content: [{ type: "text", text: user }] };
    await this.push(notice);
    this.notify({ type: "create_message", message: notice });
    await this.push({ id: crypto.randomUUID(), role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText("guard_scriptwait_stop_transcript", vars) }] });
    return true;
  }

  /**
   * Secret scan (settings enableSecretScan): before an Execute that runs `git commit`, scan what the commit would record.
   * On a hit, ask (secret_scan_violation): Proceed anyway / Proceed & report false positive / Cancel.
   * Returns the text the model gets when the command must not run, or undefined to go on.
   */
  private async secretScanGate(call: ToolUseBlock, input: Record<string, unknown>): Promise<string | undefined> {
    if (!this.deps.enableSecretScan || call.name !== "Execute" || typeof input.command !== "string") return undefined;
    let findings: ReturnType<typeof secretFindingsFor>;
    try { findings = secretFindingsFor(input.command, this.cwd); } catch (e) { this.deps.log?.(`[secret-scan] skipped: ${(e as Error)?.message ?? e}`); return undefined; }
    if (!findings.length) return undefined;
    const where = findings.slice(0, 5).map((f) => `${f.description} in ${f.file || "(unnamed)"}:${f.line}`).join("; ");
    const r = await this.askRaw(call, {
      decision: "ask", confirmationType: "secret_scan_violation", impactLevel: "high", alwaysLevel: null,
      options: [
        { label: "Proceed anyway", value: "proceed_once" },
        { label: "Proceed & report false positive", value: "proceed_report_false_positive" },
        { label: "Cancel", value: "cancel" },
      ],
      details: {
        fullCommand: input.command, command: input.command, impactLevel: "high", title: "Possible secrets in the changes to commit",
        count: findings.length, findings: findings.slice(0, 20).map(({ fingerprint: _f, ...rest }) => rest),
      },
    });
    if (r.verdict === "no_approver" || r.verdict === "rejected") {
      return `Not run: the changes to commit may contain secrets (${where}), and nobody can confirm here. Remove the secrets from the commit (unstage the files or edit them), or turn off enableSecretScan.`;
    }
    if (r.verdict === "cancel") return `The user cancelled this commit because the changes may contain secrets (${where}). Remove them from the commit before you try again.`;
    if (r.option === "proceed_report_false_positive") reportFalsePositives(this.id, findings);
    return undefined;
  }

  /** Returns "approved", "rejected" (model continues), "cancel" (turn stops) or "no_approver". */
  private async askPermission(call: ToolUseBlock, d: Extract<PermissionDecision, { decision: "ask" }>): Promise<{ verdict: "approved" | "rejected" | "cancel" | "no_approver"; comment?: string }> {
    const r = await this.askRaw(call, d);
    if (r.verdict === "approved") {
      // "Always allow" for an MCP tool or a whole MCP server is saved in the user settings (spec 5.5.5).
      const info = d.confirmationType === "mcp_tool" ? this.mcp?.findTool(String(d.details.toolName ?? "")) : undefined;
      if (info && r.option === "proceed_always_tools") rememberMcp("tool", info, String(d.details.impactLevel ?? "high"));
      if (info && r.option === "proceed_always_server") rememberMcp("server", info);
    }
    const comment = r.answer?.comment?.trim();
    return { verdict: r.verdict, ...(comment ? { comment } : {}) };
  }

  /** What a tool run sees. */
  private toolContext(signal: AbortSignal) {
    return {
      cwd: this.cwd, sessionId: this.id, readFiles: this.readFiles, signal, env: { ...this.deps.extraEnv, ...this.hookEnv },
      readLineNumbers: this.profile().readLineNumbers, imagesSupported: this.currentModel()?.noImageSupport !== true, session: this.svc,
    };
  }

  /**
   * One prompt for a batch of calls that each need approval: "Yes, allow all" / "No, cancel all" (spec 5.5.5).
   * Only when no hooks can rewrite the calls and at least two calls ask; MCP and spec-mode prompts keep their own options.
   */
  private async askBatch(calls: ToolUseBlock[], tools: Map<string, Tool>): Promise<{ ids: Set<string>; approved: Set<string>; cancelled: boolean; comment?: string } | undefined> {
    if (calls.length < 2 || !this.host.requestPermission || this.deps.autoRejectPermissionRequests || this.hooks?.hasHooks()) return undefined;
    const asks: { call: ToolUseBlock; d: Extract<PermissionDecision, { decision: "ask" }> }[] = [];
    for (const call of calls) {
      if (!tools.has(call.name) || call.name === "ExitSpecMode" || call.name === "RecommendMission" || call.name === "UpgradeModel") continue;
      const d = this.gate(call.name, call.input);
      if (d.decision === "ask" && !d.options) asks.push({ call, d });
    }
    if (asks.length < 2) return undefined;
    const ids = new Set(asks.map((a) => a.call.id));
    const requestId = crypto.randomUUID();
    const options = [{ label: "Yes, allow all", value: "proceed_once" }, { label: "No, cancel all", value: "cancel" }];
    this.setState("waiting_for_tool_confirmation");
    void this.hooks?.notification("permission_prompt", `${asks.length} tool calls need your approval`);
    const params = {
      requestId,
      toolUses: asks.map(({ call, d }) => ({
        toolUse: { type: "tool_use", id: call.id, name: call.name, input: call.input }, confirmationType: d.confirmationType,
        details: { ...d.details, ...(d.reason ? { riskLevelReason: d.details.riskLevelReason ?? d.reason } : {}) },
      })),
      options,
    };
    const ans = await this.prompt<PermissionAnswer>("permission", requestId, params, () => this.host.requestPermission!(params), { selectedOption: "cancel" });
    const ok = ans?.selectedOption === "proceed_once";
    this.notify({ type: "permission_resolved", requestId, toolUseIds: [...ids], selectedOption: ok ? "proceed_once" : "cancel" });
    const comment = ans?.comment?.trim();
    return { ids, approved: ok ? ids : new Set(), cancelled: !ok, ...(comment ? { comment } : {}) };
  }

  /** Asks the client. `option` is the chosen value, `answer` the client's whole answer (comment, edited spec). */
  private async askRaw(call: ToolUseBlock, d: Extract<PermissionDecision, { decision: "ask" }>): Promise<{
    verdict: "approved" | "rejected" | "cancel" | "no_approver"; option?: string; answer?: PermissionAnswer;
  }> {
    if (this.deps.autoRejectPermissionRequests) return { verdict: "rejected" };
    const send = this.host.requestPermission;
    if (!send) return { verdict: "no_approver" };
    let options = d.options;
    if (!options) {
      options = [{ label: "Yes, allow once", value: "proceed_once" }];
      if (d.alwaysLevel && autonomyAllowed(d.alwaysLevel, this.deps.maxAutonomy)) options.push({ label: `Yes, and always allow ${d.alwaysLevel}`, value: "proceed_always" });
      options.push({ label: "No, cancel", value: "cancel" });
    }
    this.setState("waiting_for_tool_confirmation");
    const requestId = crypto.randomUUID();
    void this.hooks?.notification("permission_prompt", `${call.name} needs your approval`);
    const params = {
      requestId,
      toolUses: [{ toolUse: { type: "tool_use", id: call.id, name: call.name, input: call.input }, confirmationType: d.confirmationType, details: { ...d.details, ...(d.reason && d.confirmationType !== "exit_spec_mode" ? { riskLevelReason: d.details.riskLevelReason ?? d.reason } : {}) } }],
      options,
    };
    const ans = await this.prompt<PermissionAnswer>("permission", requestId, params, () => send(params), { selectedOption: "cancel" });
    const valid = options.some((o) => o.value === ans?.selectedOption) ? ans.selectedOption : "cancel";
    this.notify({ type: "permission_resolved", requestId, toolUseIds: [call.id], selectedOption: valid });
    if (valid === "proceed_always" && d.alwaysLevel && AUTONOMY_RANK[d.alwaysLevel] > AUTONOMY_RANK[this.settings.autonomyLevel]) {
      this.updateSettings({ autonomyLevel: d.alwaysLevel });
    }
    return { verdict: valid === "cancel" ? "cancel" : "approved", option: valid, answer: ans };
  }

  // ---------- todos, questions, structured output, titles ----------

  getTodos(): TodoItem[] { return [...this.todos]; }

  private async setTodos(todos: TodoItem[]) {
    this.todos = todos;
    await this.deps.persistence.appendTodoState?.(todos, this.messages.length);
    this.notify({ type: "todo_state_changed", todos });
  }

  /** The todo list has open items and the model can still update it. */
  private todoNudgeWanted(): boolean {
    return this.interactive && !this.deps.isChild && this.todos.some((t) => t.status !== "completed");
  }

  /** AskUser: sends rigwell.ask_user to the client and waits; with no client the answer is "cancelled". */
  private async askUser(p: { questions: AskQuestion[] }, toolCallId: string): Promise<AskUserAnswer> {
    const send = this.host.requestAskUser;
    if (!send || this.deps.autoRejectPermissionRequests) return { cancelled: true, answers: [] };
    const requestId = crypto.randomUUID();
    const params = { requestId, toolCallId, questions: p.questions };
    this.setState("waiting_for_tool_confirmation");
    this.asking("start");
    void this.hooks?.notification("elicitation_dialog", p.questions[0]?.question ?? "The agent has a question for you");
    const raw = await this.prompt<AskUserAnswer>("ask_user", requestId, params, () => send(params), { cancelled: true, answers: [] });
    this.asking("end");
    this.setState("executing_tool");
    const answers = Array.isArray(raw?.answers)
      ? raw.answers.filter((a) => a && typeof a.answer === "string").map((a) => ({
          index: Number(a.index), question: typeof a.question === "string" ? a.question : p.questions.find((q) => q.index === a.index)?.question ?? "", answer: a.answer,
        }))
      : [];
    return { ...(raw?.cancelled ? { cancelled: true } : {}), answers };
  }

  private setStructured(value: unknown): { ok: true } | { ok: false; error: string } {
    const format = this.format;
    if (!format) return { ok: false, error: "No structured answer is wanted right now." };
    const errs = validate(value, format.schema);
    if (errs.length) {
      this.invalidStructured++;
      return { ok: false, error: `The answer does not fit the required schema:\n${errs.slice(0, 10).map((e) => `- ${e}`).join("\n")}\nFix these and call StructuredOutput again.` };
    }
    this.structured = { value };
    return { ok: true };
  }

  get sessionTitle() { return this.title.value; }
  get titleManuallySet() { return this.title.manual; }

  /** rename_session (manual) or the generated title (auto). */
  async setTitle(title: string, manual: boolean) {
    this.title = { value: title, manual, asked: true };
    await this.deps.persistence.setTitle?.(title, manual);
    this.notify({ type: "session_title_updated", title, updateType: manual ? "manual" : "auto" });
  }

  private titleWanted(): boolean {
    return this.deps.autoTitle !== false && !process.env.RIGWELL_NO_AUTO_TITLE && !this.title.manual && !this.title.asked && this.interactive && !this.deps.isChild;
  }

  /**
   * A small side request after the first user message: no tools, a one-line title (spec 6.4 idea). max_tokens is
   * 32 plus the text headroom. Skipped when the title was set by hand; failures are ignored.
   */
  private async generateTitle(firstMessage: string) {
    this.title.asked = true;
    const model = this.compactionModel();
    try {
      const cfg = this.compactionCfg();
      const max = Math.min(32 + cfg.textHeadroom, model.maxOutputTokens ?? Infinity);
      const req = {
        model, sessionId: this.id, tools: [], reasoningEffort: "off" as const, maxOutputTokens: max,
        system: ["Write a title for a coding session from the user's first message. Answer with the title only: at most six words, no quotes, no trailing period."],
        messages: [{ id: "title-request", role: "user" as const, content: [{ type: "text" as const, text: firstMessage.slice(0, 2000) }] }],
      };
      const { text, usage } = await collectSummary(this.deps.streamWithRetry(this.deps.createAdapter(model), req, { strategy: "no_retry" }));
      if (usage) { this.tokenUsage = addUsage(this.tokenUsage, usage); this.deps.onUsage?.(model.id, usage); this.notifyUsage(); }
      const clean = text.split("\n")[0]!.replace(/^["'`#*\s]+|["'`.*\s]+$/g, "").slice(0, 80);
      if (!clean || this.title.manual) return;
      await this.setTitle(clean, false);
    } catch (e) {
      this.deps.log?.(`[title] skipped: ${(e as Error)?.message ?? e}`);
    }
  }

  // ---------- usage, MCP ----------

  private notifyUsage() {
    this.notify({
      type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage,
      ...(this.children.size ? { inclusiveTokenUsage: this.inclusiveUsage() } : {}),
    });
  }

  private cumulativeChildUsage(): TokenUsage {
    let u = zeroUsage();
    for (const c of this.children.values()) u = addUsage(u, c);
    return u;
  }

  /** Keeps the deferred registry in step with the MCP servers: tools of connected servers are registered, others removed. */
  private syncMcpTools() {
    if (!this.mcp) return;
    const now = new Map(this.mcp.tools().map((t) => [t.llmName, t]));
    for (const n of [...this.mcpNames]) {
      if (!now.has(n)) { this.deferred.unregister(n); this.mcpNames.delete(n); }
    }
    for (const [n, t] of now) {
      if (!this.mcpNames.has(n)) { this.deferred.register(mcpTool(this.mcp, t)); this.mcpNames.add(n); }
    }
  }

  private needMcp(): McpManager {
    if (!this.mcp) throw new Error("MCP is not enabled for this session");
    return this.mcp;
  }
  listMcpServers() { return this.needMcp().listServers(); }
  signInMcp(name: string) { return this.needMcp().signIn(name); }
  signOutMcp(name: string) { return this.needMcp().signOut(name); }
  mcpLoginStatus(name: string, id: string) { return this.needMcp().loginStatus(name, id); }
  cancelMcpLogin(name: string, id: string) { return this.needMcp().cancelLogin(name, id); }
  addMcpServer(p: Parameters<McpManager["addServer"]>[0]) { return this.needMcp().addServer(p); }
  removeMcpServer(name: string, level: "user" = "user") { return this.needMcp().removeServer(name, level); }

  // ---------- spec mode (spec 5.5.7) ----------

  /** ExitSpecMode: always asks (exit_spec_mode); on approval saves the spec, ends spec mode at the chosen autonomy. */
  private async exitSpecMode(call: ToolUseBlock, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
    const bad = (content: string): ToolOutput => ({ content, isError: true });
    if (!this.specMode) return bad("Spec mode is not on, so there is nothing to exit.");
    let plan = typeof input.plan === "string" ? input.plan : "";
    if (!plan.trim()) return bad("plan is required: send the complete plan in markdown.");
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
    const dir = specSaveFolder(this.cwd, this.deps.specSaveDir);
    const file = specFileName(title);
    const options = [
      { label: "Yes, proceed (every action asks)", value: "proceed_once" },
      { label: "Yes, and allow file edits and read-only commands (Low)", value: "proceed_auto_run_low" },
      { label: "Yes, and allow reversible commands (Medium)", value: "proceed_auto_run_medium" },
      { label: "Yes, and allow all commands (High)", value: "proceed_auto_run_high" },
      { label: "Edit the spec first", value: "proceed_edit" },
      { label: "No, keep iterating", value: "cancel" },
    ].filter((o) => { const m = /^proceed_auto_run_(low|medium|high)$/.exec(o.value); return !m || autonomyAllowed(m[1] as AutonomyLevel, this.deps.maxAutonomy); });
    // Handoff to a new session (spec 5.5.7): offered when a client can answer and start the new session itself.
    const handoffOk = this.interactive && !this.deps.isChild;
    if (handoffOk) {
      const at = options.findIndex((o) => o.value === "proceed_edit");
      options.splice(at < 0 ? options.length - 1 : at + 1, 0,
        ...([["off", ""], ["low", "_low"], ["medium", "_medium"], ["high", "_high"]] as const)
          .filter(([lvl]) => autonomyAllowed(lvl, this.deps.maxAutonomy))
          .map(([lvl, suf]) => ({ label: `Hand off to a new session${lvl === "off" ? " (every action asks)" : ` at ${lvl}`}`, value: `proceed_new_session${suf}` })));
    }
    const savings = contextSavingsPercent(Math.ceil(plan.length / 4), this.estimateContextTokens());
    const r = await this.askRaw(call, {
      decision: "ask", confirmationType: "exit_spec_mode", impactLevel: "low", alwaysLevel: null, options,
      details: { plan, title: title ?? "Specification", filePath: `${dir}/${file}`, contextSavingsPercent: savings, supportsClientStartedHandoff: handoffOk },
    });
    if (r.verdict === "rejected" || r.verdict === "no_approver") return bad("The plan cannot be approved here: this run has no one to ask. Present the plan as your answer.");
    const comment = r.answer?.comment?.trim();
    if (r.option === "cancel" || r.verdict === "cancel") {
      return { content: `The plan was not approved. Spec mode stays on. ${comment ? `[Comment] ${comment}` : "Keep investigating or revise the plan, then propose it again."}`, data: { approved: false } };
    }
    const edited = r.option === "proceed_edit" && typeof r.answer?.editedSpecContent === "string" && r.answer.editedSpecContent.trim() ? r.answer.editedSpecContent : undefined;
    if (edited) plan = edited;
    const level = /^proceed_auto_run_(low|medium|high)$/.exec(r.option ?? "")?.[1] as AutonomyLevel | undefined;
    let saved: string | undefined;
    try { saved = saveSpec(dir, file, title, plan); } catch (e) { this.deps.log?.(`[spec] could not save: ${(e as Error)?.message ?? e}`); }
    const handoff = handoffOk ? handoffLevel(r.option) : null;
    if (handoff !== null) {
      const specHandoffId = crypto.randomUUID();
      saveHandoff({
        id: specHandoffId, plan, title: title ?? "Specification", ...(saved ? { specPath: saved } : {}),
        autonomyLevel: clampAutonomy(handoff, this.deps.maxAutonomy), cwd: this.cwd, fromSessionId: this.id, createdAt: new Date().toISOString(),
      });
      // This session leaves spec mode; the turn ends with reason spec_handoff and the client opens the new session.
      this.updateSettings({ interactionMode: "auto", autonomyLevel: "off" }, { quietModeChange: true });
      this.notify({
        type: "spec_handoff", specHandoffId, autonomyLevel: handoff, title: title ?? "Specification", ...(saved ? { specPath: saved } : {}),
        contextSavingsPercent: savings, clientStartsHandoffSession: r.answer?.clientStartsHandoffSession === true,
      });
      return {
        content: `The user approved the plan and chose to continue in a new session${saved ? ` (saved at ${saved})` : ""}. Spec mode has ended here. Do nothing more in this session.`,
        data: { approved: true, handoff: { specHandoffId, autonomyLevel: handoff } },
      };
    }
    // Spec mode ends: the tool says so in its result, so no separate mode-change reminder is queued.
    this.updateSettings({ interactionMode: "auto", autonomyLevel: level ?? "off" }, { quietModeChange: true });
    const text =
      `The user approved the plan. Spec mode has ended and all tools are available again. ` +
      (edited ? `The user edited the plan; this is the approved version:\n${plan}\n` : "") +
      (comment ? `The user added: ${comment}\n` : "") +
      (saved ? `The plan is saved at ${saved}. ` : "") + "Carry it out now.";
    return { content: text, data: { approved: true, ...(saved ? { savedTo: saved } : {}) } };
  }

  /** RecommendMission is offered in a normal session with a client that can answer, when mission mode can be entered. */
  private recommendMissionOffered(): boolean {
    return !!this.deps.enterMissionMode && this.interactive && !this.deps.isChild && this.settings.interactionMode === "auto";
  }

  /** The next model on the settings `modelUpgradePath` (known models only), or undefined. */
  nextUpgradeModel(): string | undefined {
    const path = this.deps.modelUpgradePath;
    if (!path?.length) return undefined;
    const cur = this.settings.modelId;
    const at = path.indexOf(cur);
    const rest = at < 0 ? path : path.slice(at + 1);
    return rest.find((id) => id !== cur && !!this.deps.resolveModel(id));
  }

  /** RecommendMission {reason}: asks (recommend_mission); on approval enters mission mode through the missions module. */
  private async recommendMission(call: ToolUseBlock, input: Record<string, unknown>): Promise<ToolOutput> {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) return { content: "reason is required: say why this work suits a mission.", isError: true };
    if (!this.recommendMissionOffered()) return { content: "Mission mode cannot be recommended here.", isError: true };
    const r = await this.askRaw(call, {
      decision: "ask", confirmationType: "recommend_mission", impactLevel: "low", alwaysLevel: null, details: { reason },
      options: [{ label: "Yes, switch to mission mode", value: "proceed_once" }, { label: "No, keep working here", value: "cancel" }],
    });
    if (r.verdict === "rejected" || r.verdict === "no_approver") return { content: "No one can be asked right now. Carry on in this session.", isError: true };
    const comment = r.answer?.comment?.trim();
    if (r.verdict === "cancel") return { content: `The user declined mission mode. Carry on in this session. ${comment ? `[Comment] ${comment}` : ""}`.trim(), data: { accepted: false } };
    let res: Record<string, unknown>;
    try { res = await this.deps.enterMissionMode!(); } catch (e) { return { content: `Could not enter mission mode: ${(e as Error)?.message ?? e}`, isError: true }; }
    if (res.entered !== true) {
      return { content: "The user accepted, but the folder is not ready for a mission (readiness check failed). Tell the user what the check found and carry on here.", data: { accepted: true, entered: false, readiness: res.readiness } };
    }
    return { content: `The user accepted. Mission mode is on: plan the mission with the user and propose it with ProposeMission. ${comment ? `The user added: ${comment}` : ""}`.trim(), data: { accepted: true, entered: true } };
  }

  /** UpgradeModel {reason}: asks (upgrade_model); on approval the session model becomes the next one on the upgrade path. */
  private async upgradeModel(call: ToolUseBlock, input: Record<string, unknown>): Promise<ToolOutput> {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) return { content: "reason is required: say why a stronger model is needed.", isError: true };
    const next = this.nextUpgradeModel();
    if (!next) return { content: "No stronger model is configured (settings modelUpgradePath).", isError: true };
    const from = this.settings.modelId;
    const r = await this.askRaw(call, {
      decision: "ask", confirmationType: "upgrade_model", impactLevel: "medium", alwaysLevel: null, details: { reason, fromModelId: from, toModelId: next },
      options: [{ label: `Yes, switch to ${next}`, value: "proceed_once" }, { label: "No, keep the current model", value: "cancel" }],
    });
    if (r.verdict === "rejected" || r.verdict === "no_approver") return { content: "No one can be asked right now. Carry on with the current model.", isError: true };
    const comment = r.answer?.comment?.trim();
    if (r.verdict === "cancel") return { content: `The user declined the model upgrade. Carry on with the current model. ${comment ? `[Comment] ${comment}` : ""}`.trim(), data: { approved: false } };
    // updateSettings queues the tool-mode notice when the new model changes the tool mode.
    this.updateSettings({ modelId: next });
    return { content: `The user approved. This session now uses ${next} (was ${from}), from the next request on.`, data: { approved: true, from, to: next } };
  }

  // ---------- subagents (spec 5.9) ----------

  /** The Task tool: runs a subagent as an in-process child session; background ones become jobs that wake this session. */
  private async runTaskTool(input: Record<string, unknown>, ctx: { signal: AbortSignal; toolUseId?: string }): Promise<ToolOutput> {
    const sub = this.deps.subagents;
    if (!sub) return { content: "Task is not available in this session.", isError: true };
    const parent: ParentContext = {
      sessionId: this.id, rootSessionId: sub.rootSessionId, depth: sub.depth, cwd: this.cwd,
      modelId: this.subagentModel() ?? this.currentModel()?.id ?? this.activeModelId(),
      reasoningEffort: this.deps.subagentModelSettings?.reasoningEffort ?? this.activeEffort(), autonomy: this.settings.autonomyLevel,
    };
    const toolUseId = ctx.toolUseId ?? crypto.randomUUID();
    const ac = new AbortController();
    const background = input.background === true;
    if (!background) {
      if (ctx.signal.aborted) ac.abort(); else ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    try {
      const r = await runTask(input as unknown as TaskInput, {
        parent, agents: sub.agents, limits: sub.limits, spawnChild: (p, o) => this.spawnChild(p, o, toolUseId), signal: ac.signal,
      });
      if (isStarted(r)) {
        const job = new TaskJob(r.jobId, String(input.description ?? "subagent"), r.done.then((res) => this.afterTask(res.summary.subagentType, res.report, res.outcome.error)), () => ac.abort());
        this.jobs.add(job);
        this.jobs.detach(job.id);
        return { content: JSON.stringify({ status: "running", job_id: job.id, note: "You will be woken with the report when the subagent finishes. Check or stop it with script_job." }) };
      }
      const after = await this.afterTask(r.summary.subagentType, r.report, r.outcome.error);
      this.notify({
        type: "tool_progress_update", toolUseId, toolName: "Task",
        update: { type: "status", text: `Subagent ${r.summary.status}`, details: r.summary, subagentSessionId: r.summary.childSessionId, timestamp: new Date().toISOString() },
      });
      return { content: after, isError: r.summary.status !== "completed", data: { report: after } };
    } catch (e) {
      if (e instanceof TaskError) return { content: e.message, isError: true };
      throw e;
    }
  }

  /** Settings `subagentModelSettings.model`: the model subagents without a model of their own use, when it exists. */
  private subagentModel(): string | undefined {
    const m = this.deps.subagentModelSettings?.model;
    return m && this.deps.resolveModel(m) ? m : undefined;
  }

  /** A subagent ended: SubagentStop hooks fire (results ignored); the report is what the parent gets. */
  private async afterTask(agent: string, report: string, error?: string): Promise<string> {
    void this.hooks?.subagentStop(agent, report, error);
    return report;
  }

  /** Runs one child session to the end and returns its report (the `spawnChild` of runTask). */
  private async spawnChild(prompt: string, opts: ChildOptions, toolUseId: string): Promise<ChildOutcome> {
    const sub = this.deps.subagents!;
    const t0 = Date.now();
    if (!this.deps.resolveModel(opts.modelId)) throw new Error(`Unknown model for the subagent: ${opts.modelId}`);
    const childId = crypto.randomUUID();
    const store = sub.openChild({ id: childId, cwd: opts.cwd, title: opts.description, callingSessionId: this.id, callingToolUseId: toolUseId, agentName: opts.agentName, depth: opts.depth });
    const settings: SessionSettings = {
      modelId: opts.modelId, reasoningEffort: (opts.reasoningEffort as ReasoningEffort | undefined) ?? this.settings.reasoningEffort,
      interactionMode: "auto", autonomyLevel: opts.autonomy,
    };
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: Session | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; child?.interrupt(); }, opts.inactivityTimeoutMs);
    };
    const headless = this.deps.autoRejectPermissionRequests || !this.host.requestPermission;
    child = new Session({
      ...this.deps,
      beforeTurn: undefined,
      id: childId, cwd: opts.cwd, settings,
      messages: undefined, tokenUsage: undefined, deferred: undefined, archived: undefined, compactionAnchorId: undefined,
      persistence: store.persistence, transcriptPath: store.transcriptPath,
      mcp: undefined, subagents: { ...sub, depth: opts.depth },
      // A subagent in a headless session never prompts: its permission requests are rejected (spec 5.5.6).
      autoRejectPermissionRequests: headless,
      extraSystem: opts.agentSystemPrompt ? [opts.agentSystemPrompt] : undefined,
      toolFilter: opts.allowedTools?.length ? opts.allowedTools.filter((t) => !opts.removeTools.includes(t)) : undefined,
      isChild: true,
    }, {
      notify: () => arm(),
      requestPermission: headless ? undefined : (params) => this.host.requestPermission!(params),
    });
    this.notify({
      type: "tool_progress_update", toolUseId, toolName: "Task",
      update: { type: "status", text: `Subagent started: ${opts.description}`, subagentSessionId: childId, timestamp: new Date().toISOString() },
    });
    let cancelled = false;
    const onAbort = () => { cancelled = true; child?.interrupt(); };
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true }); }
    arm();
    try {
      if (!cancelled) child.addUserMessage(prompt);
      await child.settled();
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      await child.stopBackgroundJobs().catch(() => {});
    }
    const usage = child.inclusiveUsage();
    this.children.set(childId, usage);
    this.turnChildUsage = addUsage(this.turnChildUsage, usage);
    this.notifyUsage();
    void this.persistSettings();
    const last = child.lastTurn;
    const text = last?.text.trim() ?? "";
    let status: ChildOutcome["status"] = "completed";
    let error: string | undefined;
    if (cancelled) { status = "cancelled"; error = "cancelled"; }
    else if (timedOut) { status = "failed"; error = `no activity for ${Math.round(opts.inactivityTimeoutMs / 60_000)} minutes`; }
    else if (last?.reason !== "completed") { status = "failed"; error = `the subagent ended with ${last?.reason ?? "no result"}`; }
    const report = status === "completed" ? (text || "(the subagent returned no text)") : `Subagent ${status}: ${error}.${text ? `\n${text}` : ""}`;
    return { childSessionId: childId, status, report, toolUseCount: child.toolCallCount, durationMs: Date.now() - t0, error, tokenUsage: { ...usage } };
  }

  get toolCallCount() { return this.toolCalls; }
}

function hookContext(event: string, tool: string, text: string): string {
  return `<system-reminder>\n${event} hook (${tool}):\n${text}\n</system-reminder>`;
}

export const fileName = (p: string) => basename(p);

/** The nudge when a turn ends with open todos (spec 4.2). */
export function todoNudgeText(todos: TodoItem[]): string {
  const open = todos.filter((t) => t.status !== "completed");
  return `<system-reminder>\nYour todo list still has ${open.length} open item${open.length === 1 ? "" : "s"}:\n${renderTodoList(open)}\n` +
    "Finish them now, or update the list with TodoWrite (mark done items completed, drop what no longer applies). If you are stopping on purpose, say why in your answer.\n</system-reminder>";
}

/** Applies `fn` to every string in a JSON-like value (secret redaction on outgoing notifications). */
function redactDeep(v: unknown, fn: (t: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, fn));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, fn)]));
  return v;
}

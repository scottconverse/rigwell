// Shared internal types. Every module builds against these.

export type AutonomyLevel = "off" | "low" | "medium" | "high";
export type InteractionMode = "auto" | "spec" | "mission";
export type RiskLevel = "low" | "medium" | "high";
export type ReasoningEffort =
  | "none" | "dynamic" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ---------- Transcript content (stored shape, see spec §12.1) ----------

/** `cache` is a request-time marker (cache breakpoint); the request builder sets it on copies, it is never stored. */
export type TextBlock = { type: "text"; text: string; cache?: boolean };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string; signatureProvider?: string };
export type ToolUseBlock = {
  type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
  /** Set on calls made from inside a Script (spec §3.1.7). */
  scriptExecution?: { runId: string; outerToolUseId: string };
  cache?: boolean;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** Images returned by the tool (Read of a PNG): sent to the model next to the text. */
  images?: ImageBlock[];
  cache?: boolean;
};
/** An image the model sees (user attachment or a Read result). `data` is base64. */
export type ImageBlock = { type: "image"; mediaType: string; data: string; cache?: boolean };
/** A file attachment: a base64 PDF the provider reads natively. */
export type DocumentBlock = { type: "document"; mediaType: string; data: string; name?: string; cache?: boolean };
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | DocumentBlock;

/** OpenAI Responses reasoning item kept for replay (spec §4.6.2). */
export interface OpenAIReasoning {
  id: string;
  encryptedContent?: string;
  summary?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  /** llm_only: model sees it, UI hides it. user_only: UI only. Absent: both. */
  visibility?: "llm_only" | "user_only";
  // assistant-only metadata
  modelId?: string;
  apiProvider?: string;
  reasoningEffort?: ReasoningEffort;
  openaiReasoning?: OpenAIReasoning[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
}

export const zeroUsage = (): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
});

// ---------- Models ----------

export type ProviderKind = "anthropic" | "openai";

/** One resolved model (from settings `customModels`, spec §12.2). */
export interface ModelConfig {
  id: string;            // e.g. "custom:Fake-Claude-0"
  model: string;         // name sent to the API
  displayName: string;
  provider: ProviderKind;
  baseUrl: string;       // e.g. "http://127.0.0.1:4010" (adapter appends /v1/messages or /v1/responses)
  apiKey?: string;       // already env-expanded
  extraHeaders?: Record<string, string>;
  extraArgs?: Record<string, unknown>;
  maxOutputTokens?: number;
  maxContextLimit?: number;
  reasoningEffort?: ReasoningEffort;
  noImageSupport?: boolean;
  /** Per-model profile overrides (spec 4.1); see src/agent/profiles.ts. */
  profile?: Record<string, unknown>;
  /** OpenAI-compatible wire quirk: which field carries reasoning text (spec 4.1). */
  reasoningField?: "reasoning" | "reasoning_content";
  /** Which file-edit tools the model gets (spec 4.6.4). */
  fileEditToolProfile?: "apply-patch" | "create-edit";
}

/** A tool as sent to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: ModelConfig;
  sessionId: string;
  /** System blocks in order (identity line, base prompt, ...). */
  system: string[];
  tools: ToolSpec[];
  /** Only messages the model should see (no user_only). */
  messages: Message[];
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** Cache strategy from the model profile; "none" sends no cache markers. Absent: the provider's own. */
  cacheStrategy?: "anthropic-breakpoints" | "openai-auto" | "none";
  /** Stream guards (spec §4.2). Absent: the adapter defaults (no idle limit, 10 minute hard limit). */
  limits?: { idleTimeoutMs?: number; hardLimitMs?: number };
}

/**
 * Normalized stream events. Block indexes are per assistant message, starting at 0,
 * counting every content block the adapter produces (text, thinking, tool_use) in order.
 */
export type StreamEvent =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "block_stop"; index: number }
  | {
      type: "message_done";
      /** Final, assembled content blocks (tool_use inputs parsed). */
      content: ContentBlock[];
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
      usage: TokenUsage;
      openaiReasoning?: OpenAIReasoning[];
    };

export type ModelErrorKind =
  | "auth" | "rate_limited" | "overloaded" | "network" | "timeout"
  | "rejected" | "unavailable" | "empty_response" | "unknown";

export class ModelError extends Error {
  constructor(
    public kind: ModelErrorKind,
    message: string,
    public opts: {
      status?: number; retryable?: boolean; retryAfterMs?: number;
      /** Why a "timeout" happened: no bytes for the idle limit, or the response ran past the hard limit. */
      cause?: "idle" | "hard_limit"; elapsedMs?: number; limitMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "ModelError";
  }
  get retryable(): boolean {
    return this.opts.retryable ?? false;
  }
}

export interface ModelAdapter {
  /** Streams one model response. Throws ModelError on failure (before or during the stream). */
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
}

// ---------- Tools ----------

export type ToolCategory = "read" | "edit" | "execute" | "other";

export interface FileReadRecord {
  mtimeMs: number;
  size: number;
}

export interface ToolProgress {
  type: "status";
  text?: string;          // incremental text since last update
  fullOutput?: string;    // running output so far
  exitCode?: number | null;
  signal?: string | null;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  /** absolute path -> state when last read by this session (Edit/Create freshness check). */
  readFiles: Map<string, FileReadRecord>;
  signal: AbortSignal;
  onProgress?: (p: ToolProgress) => void;
  /** Id of the tool call being run (Script names its log after it). */
  toolUseId?: string;
  /** Background jobs (Execute with background: true). */
  jobs?: import("../jobs/manager.ts").JobsApi;
  /** Extra environment for spawned commands (SessionStart hook exports). */
  env?: Record<string, string>;
  /** Model profile: Read numbers lines by default when "always" (spec 4.1, 5.4). */
  readLineNumbers?: "always" | "on_request";
  /** The model can see images (false: Read refuses an image). Default true. */
  imagesSupported?: boolean;
  /** Session services for the tools that need them (TaskOutput, TaskStop, TodoWrite, AskUser, StructuredOutput). */
  session?: SessionServices;
}

/** What the session offers its own tools. */
export interface SessionServices {
  /** Background jobs of the session (Task, Execute, Script). */
  jobs: import("../jobs/manager.ts").JobManager;
  todos: { get(): TodoItem[]; set(todos: TodoItem[]): Promise<void> };
  askUser(params: { questions: AskQuestion[] }, toolCallId: string): Promise<{ cancelled?: boolean; answers: { index: number; question: string; answer: string }[] }>;
  /** Records the model's structured answer (StructuredOutput tool). */
  setStructured(value: unknown): { ok: true } | { ok: false; error: string };
}

export interface TodoItem { id: string; content: string; status: "pending" | "in_progress" | "completed"; priority?: "low" | "medium" | "high" }
export interface AskQuestion { index: number; topic: string; question: string; options: string[]; multiSelect?: boolean }

export interface ToolOutput {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
  /** Structured form of the result, for Script (spec S1). Absent: Script derives it from `content`. */
  data?: unknown;
  /** Images to show the model with the text (Read of an image). */
  images?: ImageBlock[];
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: ToolCategory;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------- Permissions ----------

export interface CommandLists {
  allow: string[];
  deny: string[];
  block: string[];
}

export interface PermissionContext {
  autonomy: AutonomyLevel;
  interactionMode: InteractionMode;
  skipPermissions: boolean;
  lists: CommandLists;
  cwd: string;
}

export type ConfirmationType = "edit" | "create" | "exec" | "mcp_tool" | "exit_spec_mode" | "apply_patch" | "fetch_url";

export type ToolExecutionMode = "direct_only" | "script_only";

export type PermissionDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "block"; message: string }
  /** Execute without riskLevel while permissions are active: do not run, tell the model to resend. */
  | { decision: "missing_risk"; message: string }
  | {
      decision: "ask";
      confirmationType: ConfirmationType;
      details: Record<string, unknown>;
      impactLevel: RiskLevel;
      /** Lowest autonomy that would auto-approve this call; null when "always" must be hidden. */
      alwaysLevel: Exclude<AutonomyLevel, "off"> | null;
      reason?: string;
      /** Replaces the default option list (MCP tools, ExitSpecMode). */
      options?: { label: string; value: string }[];
    };

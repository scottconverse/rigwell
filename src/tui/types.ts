// TUI state, events and effects (spec §13). The reducer in reducer.ts is pure: (state, event) -> {state, effects}.

export interface Key { name: string; text?: string }

export type Item =
  | { kind: "user"; text: string; id?: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, any>; status: "running" | "ok" | "error"; phase?: string; output?: string; live?: string }
  | { kind: "info"; text: string; level: "info" | "error" };

export interface PanelOption { label: string; value: string }

export type PanelAction =
  | { type: "request"; requestId: string; method: "request_permission" | "ask_user" | "pick_options" }
  | { type: "confirm"; effects: Effect[] }
  | { type: "model" }
  | { type: "resume" }
  | { type: "rewind_pick" }
  | { type: "rewind_mode"; messageId: string; text: string };

export interface Panel {
  id: string;
  kind: "permission" | "batch" | "exit_spec" | "ask_user" | "pick_options" | "confirm" | "select";
  action: PanelAction;
  title: string;
  /** Preformatted body lines (the renderer wraps and folds them). */
  body: string[];
  /** Tag shown after the title, e.g. "(allowlisted)". */
  tag?: string;
  options: PanelOption[];
  selected: number;
  multi?: boolean;
  checked: number[];
  /** ask_user: the questions, the current index and the answers so far. */
  questions?: { index: number; topic?: string; question: string; options: string[]; multiSelect?: boolean }[];
  qIndex?: number;
  answers?: { index: number; question: string; answer: string }[];
  /** pick_options rows. */
  rows?: { id: string; label: string; detail?: string }[];
  /** exit_spec: "Will save to" path. */
  savePath?: string;
}

/** A slash-menu entry that is not built in: a custom command (Markdown file) or a user-invocable skill. */
export interface CustomEntry {
  name: string;
  kind: "command" | "skill";
  desc: string;
  argHint?: string;
  /** Command: prompt template with $ARGUMENTS / $1..$9. Skill: the skill body. */
  body: string;
  /** Skill file path (shown to the model in the wrapper). */
  filePath?: string;
  /** "project" | "user" | skill bucket, for listings. */
  origin?: string;
}

export interface ModelEntry { id: string; displayName?: string }

export interface TuiState {
  version: string;
  cwd: string;
  homeDir: string;
  idPrefix: string;
  counter: number;
  header: { agentsMd: boolean; skills: number; mcps: number; issues: number };
  /** Terminal size (set by the app; used for scroll steps). */
  rows: number;
  cols: number;
  /** Lines hidden below the transcript viewport (0 = following the bottom). */
  scroll: number;
  custom: CustomEntry[];
  /** Output of the custom status line command (spec §13.1), shown above the status bar. */
  statusLine?: string;
  statusLineHint?: string;
  statusLinePadding?: number;
  sessionId?: string;
  modelId: string;
  reasoning: string;
  autonomy: "off" | "low" | "medium" | "high";
  mode: "auto" | "spec";
  models: ModelEntry[];
  working: string;
  running: boolean;
  runStartedAt?: number;
  now: number;
  /** Provider-reported tokens of the last model call, and the compaction limit (0 = unknown). */
  contextUsed: number;
  contextLimit: number;
  tokenUsage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; thinkingTokens: number };
  turns: number;
  items: Item[];
  detailed: boolean;
  showThinking: boolean;
  input: { text: string; cursor: number };
  history: string[];
  historyIndex: number | null;
  draft: string;
  shellMode: boolean;
  vim: boolean;
  vimMode: "insert" | "normal";
  theme: "dark" | "light";
  autoCompress: boolean;
  menuIndex: number;
  menuDismissed: boolean;
  atMenu: { query: string; items: string[]; selected: number } | null;
  panels: Panel[];
  overlay: { title: string; lines: string[] } | null;
  pending: { steer: string[]; queue: string[] };
  lastEscAt: number;
  lastCtrlCAt: number;
  quit: boolean;
  hint?: string;
}

export type Effect =
  | { type: "send"; text: string; messageId: string; queuePlacement?: "end_of_turn" | "end_of_loop" }
  | { type: "interrupt" }
  | { type: "settings"; patch: Record<string, unknown> }
  | { type: "answer"; requestId: string; method: string; result: unknown }
  | { type: "quit" }
  | { type: "new_session"; cwd?: string }
  | { type: "resume"; sessionId: string }
  | { type: "list_sessions" }
  | { type: "fetch_context"; show: boolean }
  | { type: "shell"; command: string }
  | { type: "files"; query: string }
  | { type: "copy"; text: string }
  | { type: "editor"; text: string }
  | { type: "view"; name: "mcp" | "hooks" | "skills" | "commands" | "agents" | "diagnostics" | "statusline" | "automations" | "loop"; args: string }
  | { type: "rewind"; messageId: string; restoreFiles: boolean }
  | { type: "attention"; kind: "completion" | "awaiting" }
  | { type: "status_line" }
  | { type: "open_rewind" }
  | { type: "rpc"; method: string; params: Record<string, unknown>; label: string; after?: "resume_new" };

export type TuiEvent =
  | { type: "key"; key: Key; now: number }
  | { type: "notification"; n: { type: string; [k: string]: any }; now: number }
  | { type: "request"; id: string; method: string; params: any }
  | { type: "tick"; now: number }
  | { type: "session_ready"; result: any; fresh: boolean }
  | { type: "context_stats"; stats: any; show: boolean }
  | { type: "info"; text: string; level?: "info" | "error" }
  | { type: "sessions"; sessions: { id: string; title?: string; updatedAt?: string; pinned?: boolean }[] }
  | { type: "overlay"; title: string; lines: string[] }
  | { type: "extras"; custom: CustomEntry[]; skills: number; mcps?: number; issues?: number }
  | { type: "status_line"; text: string | undefined; hint?: string; padding?: number }
  | { type: "open_rewind" }
  | { type: "resize"; rows: number; cols: number }
  | { type: "rewound"; messageId: string; text: string; removedCount: number; restoredFiles: string[] }
  | { type: "file_matches"; query: string; items: string[] }
  | { type: "editor_result"; text: string }
  | { type: "disconnected"; message: string };

export interface Step { state: TuiState; effects: Effect[] }

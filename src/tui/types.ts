// TUI state, events and effects (spec §13). The reducer in reducer.ts is pure: (state, event) -> {state, effects}.

export interface Key { name: string; text?: string }

/** Display settings the TUI honors (spec 12.2): diffMode, todoDisplayMode, toolResultDisplay, outputStyle, streamAssistantResponses. */
export interface DisplaySettings {
  diffMode: "github" | "unified";
  todoDisplayMode: "pinned" | "inline";
  toolResultDisplay: "expanded" | "compact";
  /** "default", "compact" (no blank lines between items) or "plain" (no bullets or symbols). Others behave like default. */
  outputStyle: string;
  /** false: assistant text appears when the message is finished, not as it streams. */
  streamAssistantResponses: boolean;
}
export const DEFAULT_DISPLAY: DisplaySettings = {
  diffMode: "github", todoDisplayMode: "pinned", toolResultDisplay: "compact", outputStyle: "default", streamAssistantResponses: true,
};
export interface TodoView { id?: string; content: string; status: "pending" | "in_progress" | "completed" }

export type Item =
  | { kind: "user"; text: string; id?: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, any>; status: "running" | "ok" | "error"; phase?: string; output?: string; live?: string }
  | { kind: "info"; text: string; level: "info" | "error" }
  | { kind: "todos"; todos: TodoView[] }
  /** A side-chat exchange (/btw): shown apart from the main conversation. */
  | { kind: "btw"; id: string; question: string; answer: string; status: "pending" | "streaming" | "complete" | "error" };

export interface PanelOption { label: string; value: string }

export type PanelAction =
  | { type: "request"; requestId: string; method: "request_permission" | "ask_user" | "pick_options" | "request_trust" }
  | { type: "confirm"; effects: Effect[] }
  | { type: "model" }
  | { type: "resume" }
  | { type: "rewind_pick" }
  | { type: "rewind_mode"; messageId: string; text: string };

export interface Panel {
  id: string;
  kind: "permission" | "batch" | "exit_spec" | "ask_user" | "pick_options" | "trust" | "confirm" | "select";
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
  /** permission / exit_spec: the comment box (spec 13.4): Tab opens it, the text goes out as `comment` with the chosen option. */
  comment?: string;
  commentMode?: boolean;
  /** exit_spec: the plan after Ctrl+G (edited in $EDITOR); sent as editedSpecContent with proceed_edit. */
  editedSpec?: string;
  /** ask_user: the "Other..." free-text box for the current question (typing = true while it has the keys). */
  other?: { typing: boolean; text: string };
}

/** The label of the extra ask_user option that opens a free-text answer. */
export const OTHER_LABEL = "Other...";
/** The panel option value for it (never sent to the harness). */
export const OTHER_VALUE = "\u0000other";

/** An image waiting to go out with the next message (Ctrl+V). */
export interface PastedImage { mediaType: string; data: string }

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
  /** True when commands really run sandboxed (settings.sandbox.active): the SANDBOX marker in the status bar. */
  sandbox: boolean;
  /** Images pasted with Ctrl+V, sent with the next message. */
  images: PastedImage[];
  display: DisplaySettings;
  /** Top-level settings keys the org level set (shown as "[managed by org]"). */
  managed: string[];
  /** Org autonomy ceiling, when one is set. */
  maxAutonomy?: "off" | "low" | "medium" | "high";
  todos: TodoView[];
  /** Set by a spec_handoff notification; the new session starts when the turn ends with reason spec_handoff. */
  handoff?: { specHandoffId: string };
  overlay: { title: string; lines: string[] } | null;
  pending: { steer: string[]; queue: string[] };
  lastEscAt: number;
  lastCtrlCAt: number;
  quit: boolean;
  hint?: string;
}

export type Effect =
  | { type: "send"; text: string; messageId: string; queuePlacement?: "end_of_turn" | "end_of_loop"; images?: PastedImage[] }
  | { type: "paste_image" }
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
  | { type: "editor"; text: string; target?: "input" | "spec" }
  | { type: "view"; name: "mcp" | "hooks" | "skills" | "commands" | "agents" | "diagnostics" | "statusline" | "automations" | "loop" | "login" | "logout"; args: string }
  | { type: "rewind"; messageId: string; restoreFiles: boolean }
  | { type: "attention"; kind: "completion" | "awaiting" }
  | { type: "status_line" }
  | { type: "open_rewind" }
  | { type: "rpc"; method: string; params: Record<string, unknown>; label: string; after?: "resume_new" }
  /** /btw: ask the side chat (daemon.side_chat_ask). */
  | { type: "btw"; question: string }
  /** Start the new session of an approved spec handoff (initialize_session specHandoffId). */
  | { type: "handoff"; specHandoffId: string };

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
  | { type: "spec_edited"; text: string }
  | { type: "image_pasted"; image: PastedImage }
  | { type: "display"; display: Partial<DisplaySettings>; showThinking?: boolean; managed: string[]; maxAutonomy?: TuiState["maxAutonomy"] }
  | { type: "disconnected"; message: string };

export interface Step { state: TuiState; effects: Effect[] }

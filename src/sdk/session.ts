// SDK sessions: run(), createSession() (spawned exec process) and connectToDaemon() (Unix socket or WebSocket).
// All three give the same RigwellSession API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "./client.ts";
import { SocketTransport, SpawnTransport, WebSocketTransport, type SpawnOptions, type Transport } from "./transport.ts";
import { rigwellHome } from "../storage/paths.ts";

export type Notification = { type: string; [k: string]: any };

export interface PermissionRequest {
  requestId?: string;
  toolUses: { toolUse: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }; confirmationType: string; details: Record<string, any> }[];
  options: { label: string; value: string }[];
  [k: string]: unknown;
}
export interface PermissionAnswer { selectedOption: string; comment?: string }
export interface AskUserRequest { requestId?: string; toolCallId: string; questions: { index: number; topic?: string; question: string; options: string[]; multiSelect?: boolean }[] }
export interface AskUserAnswer { cancelled?: boolean; answers: { index: number; question: string; answer: string }[] }
/** rigwell.request_trust: the harness asks whether a folder with project config (hooks, skills, MCP servers...) may be trusted. */
export interface TrustRequest { cwd: string; unlocks: string[] }
export interface TrustAnswer { trust: boolean; remember?: boolean }
export interface PickOptionsRequest { toolCallId: string; title: string; hint?: string; rows: { id: string; label: string; detail?: string }[]; multi: boolean; preselectedIds: string[] }
export interface PickOptionsAnswer { cancelled?: boolean; selectedIds: string[]; refresh?: boolean }

export interface SessionOptions {
  cwd?: string;
  machineId?: string;
  modelId?: string;
  reasoningEffort?: string;
  interactionMode?: "auto" | "spec";
  autonomyLevel?: "off" | "low" | "medium" | "high";
  systemPrompt?: string;
  title?: string;
  /** Create the session with this id. */
  sessionId?: string;
  /** Resume an existing session (load_session) instead of creating one. */
  resumeSessionId?: string;
  autoRejectPermissionRequests?: boolean;
  skipPermissionsUnsafe?: boolean;
  /** Any other initialize_session params. */
  initParams?: Record<string, unknown>;
  /** Answers rigwell.request_permission. Without it (or if it throws) the SDK answers `cancel` (spec §3.1.8). */
  onPermission?: (req: PermissionRequest) => PermissionAnswer | Promise<PermissionAnswer>;
  /** Answers rigwell.ask_user. Default: `{cancelled: true, answers: []}`. */
  onAskUser?: (req: AskUserRequest) => AskUserAnswer | Promise<AskUserAnswer>;
  /** Answers rigwell.request_trust (a folder with project config). Return true/false or {trust, remember}. Default (or on a throw): untrusted. */
  onTrust?: (req: TrustRequest) => boolean | TrustAnswer | Promise<boolean | TrustAnswer>;
  /** Answers rigwell.pick_options. Default: `{cancelled: true, selectedIds: []}`. */
  onPickOptions?: (req: PickOptionsRequest) => PickOptionsAnswer | Promise<PickOptionsAnswer>;
  /** Called for every session notification. */
  onNotification?: (n: Notification) => void;
}

export interface TurnResult {
  reason: string;
  turnId?: string;
  /** Assistant text of the turn, in order. */
  text: string;
  tokenUsage?: Record<string, number>;
  durationMs?: number;
}

/** What `send()` returns: iterate for notifications (the last one is agent_turn_completed), or await `done`. */
export interface Turn extends AsyncIterable<Notification> {
  readonly messageId: string;
  readonly done: Promise<TurnResult>;
}

class TurnImpl implements Turn {
  private queue: Notification[] = [];
  private waiter?: () => void;
  private finished = false;
  private failure?: Error;
  text = "";
  readonly done: Promise<TurnResult>;
  private resolveDone!: (r: TurnResult) => void;
  private rejectDone!: (e: Error) => void;

  constructor(readonly messageId: string) {
    this.done = new Promise((res, rej) => { this.resolveDone = res; this.rejectDone = rej; });
    this.done.catch(() => {}); // iterating callers see the error from the iterator
  }

  /** Returns true when this notification ends the turn. */
  push(n: Notification): boolean {
    if (this.finished) return true;
    if (n.type === "assistant_text_delta" && typeof n.textDelta === "string") this.text += n.textDelta;
    this.queue.push(n);
    this.wake();
    if (n.type === "agent_turn_completed") {
      this.finished = true;
      this.resolveDone({ reason: n.reason, turnId: n.turnId, text: this.text, tokenUsage: n.tokenUsage, durationMs: n.durationMs });
      return true;
    }
    return false;
  }

  fail(e: Error) {
    if (this.finished) return;
    this.finished = true;
    this.failure = e;
    this.rejectDone(e);
    this.wake();
  }

  private wake() { const w = this.waiter; this.waiter = undefined; w?.(); }

  async *[Symbol.asyncIterator](): AsyncIterator<Notification> {
    for (;;) {
      const n = this.queue.shift();
      if (n) { yield n; if (n.type === "agent_turn_completed") return; continue; }
      if (this.finished) { if (this.failure) throw this.failure; return; }
      await new Promise<void>((res) => (this.waiter = res));
    }
  }
}

/** Answers a harness -> client request with the option callbacks; every default is the safe one (cancel, untrusted). */
async function answerHarnessRequest(opts: SessionOptions, method: string, params: any): Promise<unknown> {
  try {
    switch (method) {
      case "request_permission":
        return opts.onPermission ? await opts.onPermission(params) : { selectedOption: "cancel" };
      case "ask_user":
        return opts.onAskUser ? await opts.onAskUser(params) : { cancelled: true, answers: [] };
      case "request_trust": {
        const a = opts.onTrust ? await opts.onTrust(params) : false;
        return typeof a === "boolean" ? { trust: a } : { trust: a?.trust === true, ...(a?.remember === undefined ? {} : { remember: a.remember }) };
      }
      case "pick_options":
        return opts.onPickOptions ? await opts.onPickOptions(params) : { cancelled: true, selectedIds: [] };
    }
  } catch {
    if (method === "request_permission") return { selectedOption: "cancel" };
    if (method === "ask_user") return { cancelled: true, answers: [] };
    if (method === "request_trust") return { trust: false };
    return { cancelled: true, selectedIds: [] };
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

export class RigwellSession {
  readonly sessionId: string;
  settings: Record<string, any>;
  availableModels: any[];
  /** Messages restored by load_session. */
  readonly messages: any[];
  private turns = new Set<TurnImpl>();
  private listeners = new Set<(n: Notification) => void>();
  private closing = false;

  constructor(private client: RpcClient, init: any, private opts: SessionOptions) {
    this.sessionId = init.sessionId;
    this.settings = init.settings ?? {};
    this.availableModels = init.availableModels ?? [];
    this.messages = init.session?.messages ?? [];
    client.onNotification = (method, params) => {
      if (method !== "session_notification" || !params.notification) return;
      this.dispatch(params.notification as Notification);
    };
    client.onRequest = (method, params) => this.handleRequest(method, params);
    client.onClose = () => {
      const err = new Error(client.closeError?.message ?? "connection closed");
      for (const t of this.turns) {
        t.push({ type: "error", message: err.message, errorType: "ProcessExitError", timestamp: new Date().toISOString() });
        t.push({ type: "agent_turn_completed", reason: "process_exit", tokenUsage: {} });
      }
      this.turns.clear();
    };
  }

  private dispatch(n: Notification) {
    if (n.type === "settings_updated" && n.settings) this.settings = n.settings;
    this.opts.onNotification?.(n);
    for (const l of this.listeners) l(n);
    for (const t of [...this.turns]) {
      if (n.type === "agent_turn_completed" && n.turnId && n.turnId !== t.messageId) continue; // another turn's end
      if (t.push(n)) this.turns.delete(t);
    }
  }

  /** Subscribe to every notification. Returns an unsubscribe function. */
  on(listener: (n: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleRequest(method: string, params: any): Promise<unknown> { return answerHarnessRequest(this.opts, method, params); }

  /** Prompts a resumed session still has open (load_session): shown to the callbacks again, answered with answer_request. */
  reshowPending(init: any): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    const answer = (method: string, req: any) => {
      if (!req || typeof req.requestId !== "string") return;
      jobs.push(answerHarnessRequest(this.opts, method, req)
        .then((a) => this.client.request("answer_request", { requestId: req.requestId, answer: a }))
        .catch(() => {})); // already answered elsewhere, or the connection is gone
    };
    for (const r of init?.pendingPermissions ?? []) answer("request_permission", r);
    for (const r of init?.pendingAskUserRequests ?? []) answer("ask_user", r);
    return Promise.all(jobs).then(() => {});
  }

  /**
   * Send a user message. The request goes out immediately; iterate the result for notifications up to and
   * including `agent_turn_completed`, or just await `.done`.
   */
  send(text: string, extra: { messageId?: string; params?: Record<string, unknown> } = {}): Turn {
    const messageId = extra.messageId ?? crypto.randomUUID();
    const turn = new TurnImpl(messageId);
    this.turns.add(turn);
    this.client.request("add_user_message", {
      text, messageId, userMessageSource: "sdk", queuePlacement: "end_of_turn", ...(extra.params ?? {}),
    }).catch((e: Error) => { this.turns.delete(turn); turn.fail(e); });
    return turn;
  }

  interrupt(): Promise<void> { return this.client.request("interrupt_session", {}).then(() => {}); }

  updateSettings(patch: Record<string, unknown>): Promise<void> { return this.client.request("update_session_settings", patch).then(() => {}); }

  /** Any protocol method by its bare name (list_tools, get_context_stats, ...). */
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> { return this.client.request<T>(method, params); }

  listTools(params: Record<string, unknown> = {}) { return this.call<{ tools: any[] }>("list_tools", params); }
  getContextStats() { return this.call<{ used: number; remaining: number; limit: number; accuracy: string; updatedAt: string }>("get_context_stats"); }

  /** Sends close_session, then shuts the transport down (spawned process: end stdin, 2 s, SIGTERM, 3 s, SIGKILL). */
  async close(reason: "clear" | "logout" | "prompt_input_exit" | "other" = "other"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (!this.client.isClosed) await this.client.request("close_session", { reason }).catch(() => {});
    await this.client.close();
  }
}

function initParams(o: SessionOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {
    machineId: o.machineId ?? "default", cwd: o.cwd ?? process.cwd(), sessionOriginHint: "sdk", ...(o.initParams ?? {}),
  };
  for (const k of ["modelId", "reasoningEffort", "interactionMode", "autonomyLevel", "systemPrompt", "title", "sessionId", "autoRejectPermissionRequests", "skipPermissionsUnsafe"] as const) {
    if (o[k] !== undefined) p[k] = o[k];
  }
  return p;
}

/** Runs the handshake on a connected transport and returns the session. Closes the transport on failure. */
export async function openSession(transport: Transport, opts: SessionOptions): Promise<RigwellSession> {
  const client = new RpcClient(transport);
  // Notifications can arrive before the init response (settings_updated), so install a no-op handler first.
  // request_trust can arrive while initialize_session / load_session is still running.
  client.onRequest = (method, params) => answerHarnessRequest(opts, method, params);
  try {
    const init = opts.resumeSessionId
      ? await client.request("load_session", { sessionId: opts.resumeSessionId, cwd: opts.cwd ?? process.cwd(), ...(opts.autoRejectPermissionRequests ? { autoRejectPermissionRequests: true } : {}) })
      : await client.request("initialize_session", initParams(opts));
    const session = new RigwellSession(client, init, opts);
    if (opts.resumeSessionId) void session.reshowPending(init);
    return session;
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

export interface ExecSessionOptions extends SessionOptions, SpawnOptions {}

/** A multi-turn session on its own `rigwell exec --input-format stream-jsonrpc` process. */
export function createSession(opts: ExecSessionOptions = {}): Promise<RigwellSession> {
  const transport = new SpawnTransport({ ...opts, cwd: opts.cwd });
  return openSession(transport, opts);
}

export interface RunResult extends TurnResult {
  sessionId: string;
  notifications: Notification[];
}

/** One-shot: start a process, send one prompt, wait for the turn to finish, shut down. */
export async function run(prompt: string, opts: ExecSessionOptions = {}): Promise<RunResult> {
  const session = await createSession(opts);
  try {
    const notifications: Notification[] = [];
    const turn = session.send(prompt);
    for await (const n of turn) notifications.push(n);
    const r = await turn.done;
    return { ...r, sessionId: session.sessionId, notifications };
  } finally {
    await session.close();
  }
}

export interface DaemonInfo {
  pid: number;
  socketPath: string;
  ws?: { url: string; host: string; port: number };
  token?: string;
}

/** Reads $RIGWELL_HOME/daemon.json (written by the daemon with mode 0600). */
export function readDaemonInfo(home = rigwellHome()): DaemonInfo | undefined {
  try { return JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")); } catch { return undefined; }
}

export interface DaemonOptions extends SessionOptions {
  /** Unix socket path of the daemon. */
  socketPath?: string;
  /** WebSocket URL of the daemon, e.g. ws://127.0.0.1:47822/. */
  url?: string;
  /** WebSocket token. When `url` is given without a token, daemon.json is consulted. */
  token?: string;
}

/** A session hosted by a running daemon, over its Unix socket or its WebSocket. */
export async function connectToDaemon(opts: DaemonOptions = {}): Promise<RigwellSession> {
  let transport: Transport;
  if (opts.url) {
    const info = opts.token ? undefined : readDaemonInfo();
    transport = await WebSocketTransport.connect(opts.url, opts.token ?? info?.token);
  } else {
    transport = await SocketTransport.connect(opts.socketPath ?? join(rigwellHome(), "daemon.sock"));
  }
  return openSession(transport, opts);
}

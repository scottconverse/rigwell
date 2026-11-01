// One session view: a daemon connection, the transcript, pending prompts and side-chat entries.
import { DaemonConn, RpcFailure, bridge } from "./rpc.ts";
import { fromMessages, reduce, type Item } from "./transcript.ts";

export class Store<S> {
  protected state: S;
  private subs = new Set<() => void>();
  constructor(initial: S) { this.state = initial; }
  subscribe = (cb: () => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
  getSnapshot = () => this.state;
  protected set(patch: Partial<S>) { this.state = { ...this.state, ...patch }; for (const s of [...this.subs]) s(); }
}

export interface Prompt { requestId: string; method: "request_permission" | "ask_user" | "pick_options"; params: any; resolve(result: unknown): void }
export interface SideEntry { id: string; question: string; answer: string; status: "pending" | "streaming" | "complete" | "error"; createdAt: number }

export interface SessionState {
  phase: "connecting" | "ready" | "disconnected" | "error";
  error?: string;
  sessionId?: string;
  cwd: string;
  title: string;
  items: Item[];
  working: string;
  settings: { modelId?: string; reasoningEffort?: string; interactionMode?: string; autonomyLevel?: string };
  models: { id: string; displayName?: string; provider?: string }[];
  tokens: { input: number; output: number };
  prompts: Prompt[];
  sideChat: SideEntry[];
}

const empty = (cwd: string): SessionState => ({
  phase: "connecting", cwd, title: "New Session", items: [], working: "idle", settings: {}, models: [], tokens: { input: 0, output: 0 }, prompts: [], sideChat: [],
});

export type CreateOptions = { cwd: string; title?: string; modelId?: string; autonomyLevel?: string; interactionMode?: string; reasoningEffort?: string };

export class SessionController extends Store<SessionState> {
  conn?: DaemonConn;
  private terminalListeners = new Set<(n: any) => void>();

  constructor(cwd: string) { super(empty(cwd)); }

  /** Starts a new session. */
  static async create(o: CreateOptions): Promise<SessionController> {
    const c = new SessionController(o.cwd);
    await c.connect((conn) => conn.request("initialize_session", { ...o }));
    return c;
  }

  /** Reattaches to a stored session (after a reload or a daemon restart). */
  static async resume(sessionId: string, cwd: string): Promise<SessionController> {
    const c = new SessionController(cwd);
    c.set({ sessionId });
    await c.connect((conn) => conn.request("load_session", { sessionId, cwd }));
    return c;
  }

  private async connect(init: (c: DaemonConn) => Promise<any>) {
    try {
      const conn = await DaemonConn.open();
      this.conn = conn;
      conn.onNotification = (m, p) => this.onNotification(m, p);
      conn.onRequest = (m, p) => this.onRequest(m, p);
      conn.onClose = () => { this.resolveAllPrompts(); this.set({ phase: this.state.phase === "error" ? "error" : "disconnected", working: "idle" }); };
      const r = await init(conn);
      const models = (r.availableModels ?? []).map((m: any) => ({ id: m.id, displayName: m.displayName ?? m.id, provider: m.provider }));
      this.set({
        phase: "ready", sessionId: r.sessionId, cwd: r.cwd ?? this.state.cwd, items: fromMessages(r.session?.messages ?? []),
        settings: r.settings ?? {}, models, working: r.workingState ?? "idle",
        title: this.state.title,
      });
      void bridge().view.set(r.sessionId);
      void this.refreshSideChat();
    } catch (e) {
      this.set({ phase: "error", error: (e as Error).message });
      throw e;
    }
  }

  private onNotification(method: string, p: Record<string, any>) {
    if (method !== "session_notification") return;
    const n = p.notification ?? {};
    switch (n.type) {
      case "daemon.terminal_data": case "daemon.terminal_exit": for (const l of this.terminalListeners) l(n); return;
      case "daemon.side_chat_entry": this.upsertSide(n.entry); return;
      case "agent_working_state_changed": this.set({ working: n.newState }); return;
      case "settings_updated": this.set({ settings: n.settings ?? {} }); return;
      case "session_token_usage_changed": this.set({ tokens: { input: n.tokenUsage?.inputTokens ?? 0, output: n.tokenUsage?.outputTokens ?? 0 } }); return;
      case "permission_resolved": this.set({ prompts: this.state.prompts.filter((x) => x.requestId !== n.requestId) }); return;
      case "agent_turn_completed":
        this.resolveAllPrompts();
        this.set({ items: reduce(this.state.items, n), working: "idle" });
        return;
    }
    const items = reduce(this.state.items, n);
    if (items !== this.state.items) this.set({ items });
  }

  private onRequest(method: string, params: any): Promise<unknown> {
    if (method !== "request_permission" && method !== "ask_user" && method !== "pick_options") return Promise.reject(new Error(`Method not found: ${method}`));
    return new Promise((resolve) => {
      const requestId = String(params.requestId ?? crypto.randomUUID());
      this.set({ prompts: [...this.state.prompts, { requestId, method, params, resolve }] });
    });
  }

  private resolveAllPrompts() {
    for (const p of this.state.prompts) p.resolve(p.method === "request_permission" ? { selectedOption: "cancel" } : p.method === "ask_user" ? { cancelled: true, answers: [] } : { cancelled: true, selectedIds: [] });
    if (this.state.prompts.length) this.set({ prompts: [] });
  }

  answer(requestId: string, result: unknown) {
    const p = this.state.prompts.find((x) => x.requestId === requestId);
    if (!p) return;
    p.resolve(result);
    this.set({ prompts: this.state.prompts.filter((x) => x !== p) });
  }

  // ---- actions

  async send(text: string) {
    if (!this.conn || !text.trim()) return;
    this.set({ items: [...this.state.items, { kind: "user", id: `u-${Date.now()}`, text }], working: "thinking" });
    if (this.state.title === "New Session") this.set({ title: text.split("\n")[0].slice(0, 60) });
    try { await this.conn.request("add_user_message", { text }); } catch (e) { this.set({ items: [...this.state.items, { kind: "info", id: `e-${Date.now()}`, text: (e as Error).message, level: "error" }], working: "idle" }); }
  }
  interrupt() { void this.conn?.request("interrupt_session").catch(() => {}); }
  async updateSettings(patch: Record<string, unknown>) { await this.conn?.request("update_session_settings", patch); }
  request<T = any>(method: string, params: Record<string, unknown> = {}) { if (!this.conn) return Promise.reject(new RpcFailure(-32005, "not connected")); return this.conn.request<T>(method, params); }

  onTerminal(cb: (n: any) => void) { this.terminalListeners.add(cb); return () => { this.terminalListeners.delete(cb); }; }

  // ---- side chat
  private upsertSide(e: SideEntry) {
    const list = this.state.sideChat.slice();
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e; else list.push(e);
    this.set({ sideChat: list });
  }
  async refreshSideChat() { try { this.set({ sideChat: (await this.request("daemon.side_chat_list")).entries }); } catch {} }
  async askSide(question: string) { const r = await this.request("daemon.side_chat_ask", { question }); this.upsertSide(r.entry); }

  async attachBrowser() {
    const url = await bridge().browser.cdpUrl();
    if (url) await this.request("daemon.browser_attach", { cdpUrl: url }).catch(() => {});
  }

  close() { this.resolveAllPrompts(); void bridge().view.set(null); this.conn?.close(); }
}

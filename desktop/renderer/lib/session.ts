// One session view: a daemon connection, the transcript, pending prompts and side-chat entries.
import { DaemonConn, RpcFailure, bridge } from "./rpc.ts";
import { normalizeModel } from "./models.ts";
import { actionCall } from "./sessions.ts";
import { fromMessages, reduce, type Item } from "./transcript.ts";
import { nextHandoff, type HandoffState } from "./handoff.ts";

export class Store<S> {
  protected state: S;
  private subs = new Set<() => void>();
  constructor(initial: S) { this.state = initial; }
  subscribe = (cb: () => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
  getSnapshot = () => this.state;
  protected set(patch: Partial<S>) { this.state = { ...this.state, ...patch }; for (const s of [...this.subs]) s(); }
}

export interface Prompt {
  requestId: string; method: "request_permission" | "ask_user" | "pick_options"; params: any; resolve(result: unknown): void;
  /** Re-shown after load_session: answered with answer_request, and left open in the harness when the view closes. */
  reshown?: boolean;
}

/** rigwell.request_trust questions. They arrive while a session is being created or resumed, before any session view exists, so the app shows them. */
export interface TrustAsk { id: string; cwd: string; unlocks: string[]; resolve(result: { trust: boolean }): void }
class TrustAsks extends Store<{ asks: TrustAsk[] }> {
  constructor() { super({ asks: [] }); }
  add(a: TrustAsk) { this.set({ asks: [...this.state.asks, a] }); }
  answer(id: string, trust: boolean) {
    const a = this.state.asks.find((x) => x.id === id);
    if (!a) return;
    this.set({ asks: this.state.asks.filter((x) => x !== a) });
    a.resolve({ trust });
  }
}
export const trustAsks = new TrustAsks();
export interface SideEntry { id: string; question: string; answer: string; status: "pending" | "streaming" | "complete" | "error"; createdAt: number; forkId?: string; promotedTo?: string }

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
  /** Side chat may edit files ("unless the user turns writes on", spec 17.4). */
  sideWrites: boolean;
  pinned: boolean;
  archived: boolean;
}

const empty = (cwd: string): SessionState => ({
  phase: "connecting", cwd, title: "New Session", items: [], working: "idle", settings: {}, models: [], tokens: { input: 0, output: 0 }, prompts: [], sideChat: [], sideWrites: false, pinned: false, archived: false,
});

export type CreateOptions = {
  cwd: string; title?: string; modelId?: string; autonomyLevel?: string; interactionMode?: string; reasoningEffort?: string;
  /** Run the session in its own git worktree (spec §18.1). */
  worktree?: boolean | { enabled: true; lifecycle?: "ephemeral" | "persistent"; setupProfile?: string };
  /** Start from an approved spec handoff (the id of the spec_handoff notification). */
  specHandoffId?: string;
};

export type SetupOptions = CreateOptions & { templateId?: string; templateParameters?: Record<string, string> };

export class SessionController extends Store<SessionState> {
  conn?: DaemonConn;
  private terminalListeners = new Set<(n: any) => void>();
  private handoff: HandoffState = {};
  private handoffListeners = new Set<(specHandoffId: string) => void>();

  constructor(cwd: string) { super(empty(cwd)); }

  /** Starts a new session. */
  static async create(o: CreateOptions): Promise<SessionController> {
    const c = new SessionController(o.cwd);
    await c.connect((conn) => conn.request("initialize_session", { ...o }));
    return c;
  }

  /** "Create by chatting" (docs/automations.md): a session whose agent interviews the user and proposes an automation. */
  static async createSetup(o: SetupOptions): Promise<SessionController> {
    const c = new SessionController(o.cwd);
    c.set({ title: "Automation setup" });
    await c.connect((conn) => conn.request("start_automation_setup", { ...o }));
    return c;
  }

  /** Reattaches to a stored session (after a reload or a daemon restart). */
  static async resume(sessionId: string, cwd: string, info?: { title?: string; pinned?: boolean; archived?: boolean }): Promise<SessionController> {
    const c = new SessionController(cwd);
    c.set({ sessionId, ...(info?.title ? { title: info.title } : {}), pinned: info?.pinned === true, archived: info?.archived === true });
    await c.connect((conn) => conn.request("load_session", { sessionId, cwd }));
    return c;
  }

  private async connect(init: (c: DaemonConn) => Promise<any>) {
    try {
      const conn = await DaemonConn.open();
      this.conn = conn;
      conn.onNotification = (m, p) => this.onNotification(m, p);
      conn.onRequest = (m, p) => this.onRequest(m, p);
      conn.onClose = () => { this.resolveAllPrompts(false); this.set({ phase: this.state.phase === "error" ? "error" : "disconnected", working: "idle" }); };
      const r = await init(conn);
      const models = (r.availableModels ?? []).map(normalizeModel);
      this.set({
        phase: "ready", sessionId: r.sessionId, cwd: r.cwd ?? this.state.cwd, items: fromMessages(r.session?.messages ?? []),
        settings: r.settings ?? {}, models, working: r.workingState ?? "idle",
        title: this.state.title,
      });
      this.reshowPending(conn, r);
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
      case "session_title_updated": if (typeof n.title === "string" && n.title) this.set({ title: n.title }); return;
      case "session_token_usage_changed": this.set({ tokens: { input: n.tokenUsage?.inputTokens ?? 0, output: n.tokenUsage?.outputTokens ?? 0 } }); return;
      case "permission_resolved": this.set({ prompts: this.state.prompts.filter((x) => x.requestId !== n.requestId) }); return;
      case "spec_handoff":
        this.followHandoff(n); return;
      case "agent_turn_completed":
        this.followHandoff(n);
        this.resolveAllPrompts();
        this.set({ items: reduce(this.state.items, n), working: "idle" });
        return;
    }
    const items = reduce(this.state.items, n);
    if (items !== this.state.items) this.set({ items });
  }

  /** An approved spec handoff: once the notification and the ending turn were both seen, the new session is opened by the listener. */
  private followHandoff(n: Record<string, any>) {
    const r = nextHandoff(this.handoff, n);
    this.handoff = r.state;
    if (r.start) for (const l of [...this.handoffListeners]) l(r.start);
  }
  onHandoff(cb: (specHandoffId: string) => void) { this.handoffListeners.add(cb); return () => { this.handoffListeners.delete(cb); }; }

  /** Prompts a reattached session still waits on (load_session pendingPermissions / pendingAskUserRequests). */
  private reshowPending(conn: DaemonConn, r: any) {
    const add = (method: Prompt["method"], list: any[]) => {
      for (const params of list ?? []) {
        const requestId = typeof params?.requestId === "string" ? params.requestId : "";
        if (!requestId || this.state.prompts.some((x) => x.requestId === requestId)) continue;
        const resolve = (answer: unknown) => { void conn.request("answer_request", { requestId, answer }).catch(() => {}); };
        this.set({ prompts: [...this.state.prompts, { requestId, method, params, resolve, reshown: true }] });
      }
    };
    add("request_permission", r.pendingPermissions);
    add("ask_user", r.pendingAskUserRequests);
  }

  private onRequest(method: string, params: any): Promise<unknown> {
    if (method === "request_trust") {
      return new Promise((resolve) => trustAsks.add({ id: crypto.randomUUID(), cwd: String(params.cwd ?? this.state.cwd), unlocks: Array.isArray(params.unlocks) ? params.unlocks.map(String) : [], resolve }));
    }
    if (method !== "request_permission" && method !== "ask_user" && method !== "pick_options") return Promise.reject(new Error(`Method not found: ${method}`));
    return new Promise((resolve) => {
      const requestId = String(params.requestId ?? crypto.randomUUID());
      this.set({ prompts: [...this.state.prompts, { requestId, method, params, resolve }] });
    });
  }

  /** `cancelReshown` false (the view closes): prompts shown again after a reload stay open in the harness for the next load_session. */
  private resolveAllPrompts(cancelReshown = true) {
    for (const p of this.state.prompts) if (cancelReshown || !p.reshown) p.resolve(p.method === "request_permission" ? { selectedOption: "cancel" } : p.method === "ask_user" ? { cancelled: true, answers: [] } : { cancelled: true, selectedIds: [] });
    if (this.state.prompts.length) this.set({ prompts: [] });
  }

  answer(requestId: string, result: unknown) {
    const p = this.state.prompts.find((x) => x.requestId === requestId);
    if (!p) return;
    p.resolve(result);
    this.set({ prompts: this.state.prompts.filter((x) => x !== p) });
  }

  // ---- actions

  async send(text: string, attach: { images?: { mediaType: string; data: string }[]; files?: { name: string; mediaType: string; data: string }[] } = {}) {
    if (!this.conn || !text.trim()) return;
    const names = [...(attach.images ?? []).map((_, i) => `image ${i + 1}`), ...(attach.files ?? []).map((f) => f.name)];
    const shown = names.length ? `${text}\n[Attached: ${names.join(", ")}]` : text;
    if (this.attaching) await Promise.race([this.attaching, new Promise((r) => setTimeout(r, 3000))]);
    this.set({ items: [...this.state.items, { kind: "user", id: `u-${Date.now()}`, text: shown, ...(attach.images?.length ? { images: attach.images } : {}) }], working: "thinking" });
    if (this.state.title === "New Session") this.set({ title: text.split("\n")[0].slice(0, 60) });
    try { await this.conn.request("add_user_message", { text, ...(attach.images?.length ? { images: attach.images } : {}), ...(attach.files?.length ? { files: attach.files } : {}) }); } catch (e) { this.set({ items: [...this.state.items, { kind: "info", id: `e-${Date.now()}`, text: (e as Error).message, level: "error" }], working: "idle" }); }
  }
  interrupt() { void this.conn?.request("interrupt_session").catch(() => {}); }
  async updateSettings(patch: Record<string, unknown>) { await this.conn?.request("update_session_settings", patch); }

  // ---- header menu (spec §14.3): rename, pin, archive
  async rename(title: string) { const c = actionCall("rename", {}, title); await this.request(c.method, c.params); this.set({ title: String(c.params.title) }); }
  async setPinned(pinned: boolean) { await this.request("pin_session", { pinned }); this.set({ pinned }); }
  async setArchived(archived: boolean) { await this.request("archive_session", { archived }); this.set({ archived }); }

  // ---- missions (spec §15.1): the mode chip's Mission entry
  async enterMission(continueAnyway = false): Promise<{ entered: boolean; readiness?: any; modelSwitched?: string }> {
    const r = await this.request("enter_mission_mode", continueAnyway ? { continue: true } : {});
    if (r.entered) {
      // Worker and validator models from the Missions settings page become this session's missionSettings.
      try {
        const m = (await bridge().userSettings.get()).missions ?? {};
        const ms: Record<string, unknown> = {};
        for (const k of ["workerModel", "workerReasoningEffort", "validationWorkerModel", "validationWorkerReasoningEffort", "skipScrutiny", "skipUserTesting"]) if (m[k] !== undefined) ms[k] = m[k];
        if (Object.keys(ms).length) await this.request("update_session_settings", { missionSettings: ms });
      } catch { /* the defaults stay */ }
    }
    return r;
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}) { if (!this.conn) return Promise.reject(new RpcFailure(-32005, "not connected")); return this.conn.request<T>(method, params); }

  onTerminal(cb: (n: any) => void) { this.terminalListeners.add(cb); return () => { this.terminalListeners.delete(cb); }; }

  // ---- side chat
  private upsertSide(e: SideEntry) {
    const list = this.state.sideChat.slice();
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e; else list.push(e);
    this.set({ sideChat: list });
  }
  /** Counts writes-switch changes, so a list reply sent before a change does not put the old value back. */
  private writesSeq = 0;
  async refreshSideChat() {
    const seq = this.writesSeq;
    try {
      const r = await this.request("daemon.side_chat_list");
      this.set(seq === this.writesSeq ? { sideChat: r.entries, sideWrites: r.writes === true } : { sideChat: r.entries });
    } catch {}
  }
  /** The switch shows the new value at once (it does not wait for the daemon) and goes back if the call fails. */
  async setSideWrites(enabled: boolean) {
    const seq = ++this.writesSeq;
    const before = this.state.sideWrites;
    this.set({ sideWrites: enabled });
    try {
      const r = await this.request("daemon.side_chat_set_writes", { enabled });
      if (seq === this.writesSeq) this.set({ sideWrites: r.writes === true });
    } catch (e) {
      if (seq === this.writesSeq) this.set({ sideWrites: before });
      throw e;
    }
  }
  /** Promote: the side chat becomes a normal session in this project (spec 17.4). Returns the new session id. */
  async promoteSide(entryId: string): Promise<string> { const r = await this.request("daemon.side_chat_promote", { entryId }); void this.refreshSideChat(); return String(r.sessionId); }
  async askSide(question: string) { const r = await this.request("daemon.side_chat_ask", { question }); this.upsertSide(r.entry); }

  private attaching?: Promise<void>;
  /** Registers the browser pane with the daemon. `send` waits for this (briefly), so a Browser tool call never beats the attach. */
  attachBrowser(): Promise<void> {
    return (this.attaching ??= (async () => {
      const url = await bridge().browser.cdpUrl();
      if (url) await this.request("daemon.browser_attach", { cdpUrl: url }).catch(() => {});
    })());
  }

  close() { this.resolveAllPrompts(false); void bridge().view.set(null); this.conn?.close(); }
}

// Broker in the main process (spec §14.1). The daemon hosts one session per connection, so a window opens one
// connection per session view. The broker owns those WebSockets: it records which window opened each connection,
// routes the daemon's messages only to that window, replays the last daemon status to late windows, and feeds
// attention tracking (notifications, sounds, badge) with everything it relays.
import { AttentionTracker, type AttentionEvent } from "../../src/sidepane/attention.ts";

export interface DaemonEndpoint { wsUrl: string; token: string }

export interface BrokerHost {
  /** Delivers a message to one window (webContents id). */
  deliver(windowId: number, channel: string, payload: unknown): void;
  /** An attention event worth acting on (notification, sound, badge). `open` is the set of unanswered requests. */
  onAttention(ev: AttentionEvent, open: AttentionEvent[]): void;
  /** The set of connections whose agent is working changed (tray icon and tooltip). */
  onActivity?(active: number): void;
  log?(m: string): void;
}

interface Conn {
  id: number;
  windowId: number;
  ws: WebSocket;
  sessionId?: string;
  /** The agent is working on a turn (anything but idle). */
  working?: boolean;
  /** Requests from the daemon that the window has not answered yet: request id -> method. */
  asked: Map<string, string>;
  ready: Promise<void>;
}

export class DaemonBroker {
  private conns = new Map<number, Conn>();
  private nextId = 1;
  private tracker = new AttentionTracker();
  private open = new Map<string, AttentionEvent>(); // requestId -> event
  private status: { state: string; error?: string } = { state: "stopped" };

  constructor(private endpoint: () => DaemonEndpoint | undefined, private host: BrokerHost, private WS: typeof WebSocket = WebSocket) {}

  get connectionCount() { return this.conns.size; }
  get lastStatus() { return this.status; }
  /** Sessions whose agent is working right now (one per connection). */
  get activeCount() { let n = 0; for (const c of this.conns.values()) if (c.working) n++; return n; }
  /** Unanswered requests that need the user. */
  get attentionCount() { return this.open.size; }
  private activity() { this.host.onActivity?.(this.activeCount); }

  /** Sets and broadcasts the daemon's status ("running", "restarting"...). Late windows ask for the cached value. */
  setStatus(s: { state: string; error?: string }, windows: number[]) {
    this.status = s;
    for (const w of windows) this.host.deliver(w, "daemon:status", s);
  }

  async openConnection(windowId: number): Promise<number> {
    const ep = this.endpoint();
    if (!ep) throw new Error("The background service is not running");
    const u = new URL(ep.wsUrl);
    u.searchParams.set("token", ep.token);
    const ws = new this.WS(u.toString());
    const id = this.nextId++;
    const conn: Conn = { id, windowId, ws, asked: new Map(), ready: undefined as unknown as Promise<void> };
    conn.ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not connect to the background service")), { once: true });
    });
    this.conns.set(id, conn);
    ws.addEventListener("message", (ev) => this.fromDaemon(conn, typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)));
    ws.addEventListener("close", () => {
      if (this.conns.delete(id)) this.host.deliver(windowId, "daemon:closed", { connId: id });
      this.dropOpen(conn);
      if (conn.working) this.activity();
    });
    try { await conn.ready; } catch (e) { this.conns.delete(id); throw e; }
    return id;
  }

  /** A string from the window to the daemon. Only the window that opened the connection may use it. */
  send(windowId: number, connId: number, message: unknown) {
    const c = this.conns.get(connId);
    if (!c || c.windowId !== windowId) throw new Error("Unknown connection");
    if (typeof message !== "string") throw new Error("Messages must be strings");
    let parsed: any;
    try { parsed = JSON.parse(message); } catch { throw new Error("Message is not JSON"); }
    // A response to a daemon request resolves its attention event.
    if (parsed?.type === "response" && typeof parsed.id === "string" && c.asked.delete(parsed.id)) {
      const ev = this.tracker.resolve(c.sessionId ?? "", parsed.id);
      this.open.delete(parsed.id);
      if (ev) this.host.onAttention(ev, [...this.open.values()]);
    }
    if (c.ws.readyState === 1) c.ws.send(message);
  }

  closeConnection(windowId: number, connId: number) {
    const c = this.conns.get(connId);
    if (!c || c.windowId !== windowId) return;
    this.conns.delete(connId);
    this.dropOpen(c);
    if (c.working) this.activity();
    try { c.ws.close(); } catch {}
  }

  /** The window went away or reloaded: close its connections (terminals live on in the daemon, spec §17.2). */
  closeWindow(windowId: number) {
    for (const c of [...this.conns.values()]) if (c.windowId === windowId) this.closeConnection(windowId, c.id);
  }

  /** Closes every connection. With `notify`, windows are told (the daemon went away); on quit they are not. */
  closeAll(notify = false) {
    for (const c of [...this.conns.values()]) {
      this.closeConnection(c.windowId, c.id);
      if (notify) this.host.deliver(c.windowId, "daemon:closed", { connId: c.id });
    }
  }

  /** All connections died (daemon restarted): tell their windows. */
  private dropOpen(c: Conn) {
    let changed = false;
    for (const id of c.asked.keys()) if (this.open.delete(id)) changed = true;
    c.asked.clear();
    if (changed) this.host.onAttention({ kind: "attention_resolved", sessionId: c.sessionId ?? "", summary: "", detail: "", at: Date.now() }, [...this.open.values()]);
  }

  private fromDaemon(c: Conn, text: string) {
    this.host.deliver(c.windowId, "daemon:message", { connId: c.id, message: text });
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m?.result?.sessionId === "string") c.sessionId = m.result.sessionId;
    if (m?.type === "notification" || (m?.method && m.id == null)) {
      if (typeof m.params?.sessionId === "string") c.sessionId = m.params.sessionId;
      if (m.method === "rigwell.session_notification" && c.sessionId) {
        const nested = typeof m.params?.notification?.agentId === "string"; // subagent traffic carries an agent id
        const n = m.params.notification ?? {};
        if (!nested && n.type === "agent_working_state_changed") { const w = n.newState !== "idle"; if (w !== !!c.working) { c.working = w; this.activity(); } }
        for (const ev of this.tracker.onNotification(c.sessionId, m.params.notification ?? {})) this.attention(ev, nested);
      }
    } else if (m?.type === "request" && typeof m.method === "string" && typeof m.id === "string") {
      const method = m.method.replace(/^rigwell\./, "");
      const ev = this.tracker.onRequest(c.sessionId ?? "", method, m.id, m.params ?? {});
      if (ev) { c.asked.set(m.id, method); this.open.set(m.id, ev); this.attention(ev); }
    }
  }

  private attention(ev: AttentionEvent, nested = false) {
    void nested;
    if (ev.kind === "attention_resolved") this.open.delete(ev.requestId ?? "");
    this.host.onAttention(ev, [...this.open.values()]);
  }
}

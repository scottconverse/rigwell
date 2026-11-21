// App-wide state: daemon status, the session list (from a control connection), settings and models.
import { useSyncExternalStore } from "react";
import type { DesktopSettings } from "../../main/settings.ts";
import { DaemonConn, RpcFailure, bridge } from "./rpc.ts";
import { Store } from "./session.ts";
import { normalizeModel, type ModelRow } from "./models.ts";
import { actionCall, applySessionState, clearSessionStates, normalizeSession, projectArchiveTargets, type SessionAction, type SessionRow, type WorkstreamRow } from "./sessions.ts";

export type { ModelRow, SessionRow };

export interface AppState {
  daemon: { state: string; error?: string };
  sessions: SessionRow[];
  workstreams: WorkstreamRow[];
  models: ModelRow[];
  settings?: DesktopSettings;
  recentFolders: string[];
  /** The agent's user settings with secrets masked (customModels, trustedFolders, sessionDefaultSettings, ...). */
  userSettings: Record<string, any>;
}

const RECENT_KEY = "rigwell.recentFolders";
const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };

export class AppModel extends Store<AppState> {
  private control?: DaemonConn;
  private refreshVersion = 0;
  constructor() { super({ daemon: { state: "stopped" }, sessions: [], workstreams: [], models: [], recentFolders: loadRecent(), userSettings: {} }); }

  /** Opens the control connection. It listens for list, state and workstream changes. */
  private async openControl() {
    const c = await DaemonConn.open();
    this.control = c;
    c.onNotification = (method, p) => {
      if (method === "session_list_changed") void this.refresh();
      else if (method === "session_state_changed") {
        // A new session is not in the list yet. Only then does the list load again.
        if (p.state !== "idle" && !this.state.sessions.some((r) => r.id === p.sessionId)) void this.refresh();
        else this.set({ sessions: applySessionState(this.state.sessions, String(p.sessionId), p.state) });
      }
      else if (method === "session_notification" && p.notification?.type === "workstream_updated") void this.refreshWorkstreams();
    };
    c.onClose = () => { if (this.control === c) this.control = undefined; this.set({ sessions: clearSessionStates(this.state.sessions) }); };
    void this.refreshWorkstreams();
    return c;
  }

  /** `list_workstreams` also asks the daemon to send this connection every workstream change. */
  private async refreshWorkstreams() {
    try { this.set({ workstreams: ((await this.control?.request("list_workstreams"))?.workstreams ?? []) as WorkstreamRow[] }); }
    catch { /* the daemon is restarting; the next refresh reads the list again */ }
  }

  async start() {
    const b = bridge();
    b.daemon.onStatus((s) => { this.set({ daemon: s, ...(s.state === "running" ? {} : { sessions: clearSessionStates(this.state.sessions) }) }); if (s.state === "running") void this.refresh(); });
    this.set({ daemon: await b.daemon.status() });
    this.set({ settings: (await b.settings.get()) as DesktopSettings });
    b.settings.onChanged((s) => this.set({ settings: s as DesktopSettings }));
    if (this.state.daemon.state === "running") void this.refresh();
  }

  /** (Re)reads the session list and the models over a control connection. */
  async refresh() {
    const version = ++this.refreshVersion;
    try {
      if (!this.control || this.control.closed) await this.openControl();
      const [s, m] = await Promise.all([this.listSessions(this.control!), this.control!.request("list_models")]);
      if (version !== this.refreshVersion) return;
      this.set({ sessions: s, models: (m.models ?? []).map(normalizeModel) });
      void this.refreshUserSettings();
    } catch { /* the daemon is restarting; the status event triggers another refresh */ }
  }

  /** `rigwell.list_sessions` (pinned, archived, subagent flags); falls back to the sidebar method of older daemons. */
  private async listSessions(c: DaemonConn): Promise<SessionRow[]> {
    try {
      const r = await c.request("list_sessions", { includeArchived: true });
      return (r.sessions ?? []).map(normalizeSession);
    } catch (e) {
      if (!(e instanceof RpcFailure) || e.code !== -32601) throw e;
      const r = await c.request("daemon.list_sessions");
      return (r.sessions ?? []).map(normalizeSession);
    }
  }

  /** A request on the app's control connection (methods that need no session: automations, missions list, models). */
  async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.control || this.control.closed) await this.openControl();
    return this.control!.request<T>(method, params);
  }

  async refreshUserSettings() { try { this.set({ userSettings: await bridge().userSettings.get() }); } catch { /* keep the old copy */ } }
  async updateUserSettings(patch: Record<string, unknown>) { this.set({ userSettings: await bridge().userSettings.update(patch) }); }

  /** Runs `fn` on a short-lived connection that has `sessionId` loaded (for actions on sessions that are not on screen). */
  async withSession<T>(sessionId: string, cwd: string | undefined, fn: (c: DaemonConn) => Promise<T>): Promise<T> {
    const c = await DaemonConn.open();
    try {
      await c.request("load_session", { sessionId, cwd: cwd ?? "/" });
      return await fn(c);
    } finally { c.close(); }
  }

  async sessionAction(row: SessionRow, action: SessionAction, value?: string) {
    const call = actionCall(action, row, value);
    await this.withSession(row.id, row.cwd, (c) => c.request(call.method, call.params));
    await this.refresh();
  }

  /** Sidebar row menu "Archive Project" (spec 14.3): archives every session of the project; returns how many. */
  async archiveProject(cwd: string): Promise<number> {
    const rows = projectArchiveTargets(this.state.sessions, cwd);
    const call = actionCall("archive", { archivedAt: null });
    for (const row of rows) await this.withSession(row.id, row.cwd, (c) => c.request(call.method, call.params));
    await this.refresh();
    return rows.length;
  }

  /** The folder trust prompt (spec §5.6) was accepted. */
  async trust(folder: string) { await bridge().userSettings.trustFolder(folder); await this.refreshUserSettings(); }
  isTrusted = (folder: string) => !!this.state.userSettings.trustedFolders?.[folder];

  rememberFolder(path: string) {
    const list = [path, ...this.state.recentFolders.filter((p) => p !== path)].slice(0, 12);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
    this.set({ recentFolders: list });
  }

  async updateSettings(patch: unknown) { this.set({ settings: (await bridge().settings.update(patch)) as DesktopSettings }); }
}

export const app = new AppModel();
export const useApp = () => useSyncExternalStore(app.subscribe, app.getSnapshot);
export function useStore<S>(store: Store<S>): S { return useSyncExternalStore(store.subscribe, store.getSnapshot); }

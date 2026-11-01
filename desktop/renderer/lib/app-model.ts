// App-wide state: daemon status, the session list (from a control connection), settings and models.
import { useSyncExternalStore } from "react";
import type { DesktopSettings } from "../../main/settings.ts";
import { DaemonConn, bridge } from "./rpc.ts";
import { Store } from "./session.ts";

export interface SessionRow { id: string; title: string; cwd?: string; updatedAt: number }
export interface ModelRow { id: string; displayName?: string; provider?: string }

export interface AppState {
  daemon: { state: string; error?: string };
  sessions: SessionRow[];
  models: ModelRow[];
  settings?: DesktopSettings;
  recentFolders: string[];
}

const RECENT_KEY = "rigwell.recentFolders";
const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };

class AppModel extends Store<AppState> {
  private control?: DaemonConn;
  constructor() { super({ daemon: { state: "stopped" }, sessions: [], models: [], recentFolders: loadRecent() }); }

  async start() {
    const b = bridge();
    b.daemon.onStatus((s) => { this.set({ daemon: s }); if (s.state === "running") void this.refresh(); });
    this.set({ daemon: await b.daemon.status() });
    this.set({ settings: (await b.settings.get()) as DesktopSettings });
    b.settings.onChanged((s) => this.set({ settings: s as DesktopSettings }));
    if (this.state.daemon.state === "running") void this.refresh();
  }

  /** (Re)reads the session list and the models over a control connection. */
  async refresh() {
    try {
      if (!this.control || this.control.closed) {
        this.control = await DaemonConn.open();
        this.control.onClose = () => { this.control = undefined; };
      }
      const [s, m] = await Promise.all([this.control.request("daemon.list_sessions"), this.control.request("list_models")]);
      this.set({ sessions: s.sessions, models: m.models ?? [] });
    } catch { /* the daemon is restarting; the status event triggers another refresh */ }
  }

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

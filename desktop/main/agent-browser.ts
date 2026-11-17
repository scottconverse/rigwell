import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import type { Session, WebContents } from "electron";
import type { PaneHost, PaneTarget } from "./cdp-proxy.ts";
import { allowedBrowserRequest } from "../../src/browser/network.ts";
import { resolvedBrowserPath } from "../../src/browser/paths.ts";
import { contains } from "../../src/sandbox/policy.ts";

export interface HiddenTarget extends PaneTarget { close(): Promise<void> }
/** A scoped host exposes this pane when present, otherwise its own hidden Electron pages. */
export function sessionBrowserHost(o: {
  visible(): PaneTarget[]; createVisible(url: string): Promise<PaneTarget>; createHidden(url: string): Promise<HiddenTarget>;
  closeVisible(id: string): Promise<void>; activateVisible(id: string): void;
  setPolicy(target: PaneTarget, params: Record<string, unknown>): Promise<void>;
}) {
  const hidden = new Map<string, HiddenTarget>();
  const targets = () => {
    const visible = o.visible();
    if (visible.length) { const obsolete = [...hidden.values()]; hidden.clear(); for (const target of obsolete) void target.close().catch(() => {}); return visible; }
    return [...hidden.values()];
  };
  const host: PaneHost = {
    targets,
    async createTab(url) { if (o.visible().length) return o.createVisible(url); const t = await o.createHidden(url); hidden.set(t.id, t); return t; },
    async closeTab(id) { const t = hidden.get(id); if (t) { hidden.delete(id); await t.close(); } else if (o.visible().some((t) => t.id === id)) await o.closeVisible(id); else throw new Error("Browser tab belongs to another session"); },
    activateTab(id) { if (o.visible().some((t) => t.id === id)) o.activateVisible(id); else if (!hidden.has(id)) throw new Error("Browser tab belongs to another session"); },
    async setPolicy(params) { const t = targets().find((t) => t.id === params.targetId); if (!t) throw new Error("Browser tab belongs to another session"); await o.setPolicy(t, params); },
  };
  return { host, async close() { const all = [...hidden.values()]; hidden.clear(); await Promise.all(all.map((t) => t.close())); } };
}
interface Rules { allowed: string[]; denied: string[]; writable: string[]; blockedPaths: string[]; downloadPath?: string }
const strings = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 2000 || value.some((v) => typeof v !== "string")) throw new Error("Invalid browser policy list"); return value; };
export class BrowserRequestGuards {
  private sessions = new Map<Session, { strict: boolean; rules: Map<number, Rules> }>();
  install(ses: Session, strict = false) {
    if (this.sessions.has(ses)) return;
    const state = { strict, rules: new Map<number, Rules>() }; this.sessions.set(ses, state);
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const id = details.webContentsId ?? -1;
      const own = state.rules.get(id);
      // Worker requests may lack a webContents id. Constrain unattributed traffic by all active policies.
      const applicable = own ? [own] : id <= 0 || state.strict ? [...state.rules.values()] : [];
      callback({ cancel: applicable.some((r) => !allowedBrowserRequest(details.url, r.allowed, r.denied)) || (state.strict && !applicable.length && details.url !== "about:blank") });
    });
    ses.on("will-download", (event, item, wc) => {
      const rules = wc && state.rules.get(wc.id);
      if (!rules) { if (state.strict || !wc && state.rules.size) event.preventDefault(); return; }
      if (!rules.downloadPath) { event.preventDefault(); return; }
      const file = join(rules.downloadPath, `${randomUUID()}-${basename(item.getFilename())}`);
      const target = resolvedBrowserPath(file);
      if (!contains(resolvedBrowserPath(rules.downloadPath), target) || !rules.writable.some((r) => contains(resolvedBrowserPath(r), target)) || rules.blockedPaths.some((r) => contains(resolvedBrowserPath(r), target))) { event.preventDefault(); return; }
      item.setSavePath(target);
    });
  }
  set(wc: WebContents, raw: Record<string, unknown>) {
    const rules: Rules = { allowed: strings(raw.allowed), denied: strings(raw.denied), writable: strings(raw.writable), blockedPaths: strings(raw.blockedPaths) };
    if (raw.downloadPath !== undefined) { if (typeof raw.downloadPath !== "string" || !isAbsolute(raw.downloadPath)) throw new Error("Invalid browser download path"); rules.downloadPath = raw.downloadPath; }
    this.install(wc.session); const map = this.sessions.get(wc.session)!.rules;
    if (!map.has(wc.id)) wc.once("destroyed", () => map.delete(wc.id));
    map.set(wc.id, rules);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  }
}

// Browser tab (spec §17.3): <webview> tabs on their own persistent partition. Every webview registers with the main
// process, which exposes it to the agent through the CDP proxy. This component stays mounted while the pane is hidden so
// the agent can keep driving a page.
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { moveTab, pushClosed, stepTab } from "../lib/tabs.ts";
import { CookieImportDialog } from "./CookieImport.tsx";

interface Tab { key: string; /** the address the webview was created with; never changes, so state updates cannot re-navigate it */ src: string; url: string; title: string; requestId?: string; wcId?: number; canBack: boolean; canForward: boolean; loading: boolean }
const PARTITION = "persist:browserpanel";

function normalize(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^(https?:|about:)/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

function WebviewTab({ tab, sessionId, onState, onGone }: { tab: Tab; sessionId?: string; onState(key: string, patch: Partial<Tab>): void; onGone(key: string): void }) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const upd = () => onState(tab.key, { url: wv.getURL?.() ?? tab.url, title: wv.getTitle?.() ?? "", canBack: wv.canGoBack?.() ?? false, canForward: wv.canGoForward?.() ?? false });
    const ready = () => { const id = wv.getWebContentsId(); void bridge().browser.register(id, tab.requestId, sessionId).then(() => onState(tab.key, { wcId: id })).catch(() => {}); upd(); };
    const handlers: [string, (e?: any) => void][] = [
      ["dom-ready", ready], ["did-navigate", upd], ["did-navigate-in-page", upd], ["page-title-updated", upd],
      ["did-start-loading", () => onState(tab.key, { loading: true })], ["did-stop-loading", () => { onState(tab.key, { loading: false }); upd(); }],
      ["destroyed", () => onGone(tab.key)],
    ];
    for (const [n, h] of handlers) wv.addEventListener(n, h);
    return () => { for (const [n, h] of handlers) wv.removeEventListener(n, h); };
  }, [tab.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return createElement("webview", { ref, src: tab.src, partition: PARTITION, className: "webview" });
}

export function BrowserTab({ visible, sessionId, onWantVisible }: { visible: boolean; sessionId?: string; onWantVisible(): void }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("");
  const [address, setAddress] = useState("");
  const counter = useRef(0);

  const open = useCallback((url: string, requestId?: string) => {
    const key = `tab-${++counter.current}`;
    setTabs((t) => [...t, { key, src: normalize(url), url: normalize(url), title: "", requestId, canBack: false, canForward: false, loading: true }]);
    setActive(key);
    return key;
  }, []);
  const patch = useCallback((key: string, p: Partial<Tab>) => setTabs((t) => t.map((x) => (x.key === key ? { ...x, ...p } : x))), []);
  const [closed, setClosed] = useState<string[]>([]);
  const close = useCallback((key: string) => setTabs((t) => {
    const gone = t.find((x) => x.key === key);
    if (gone) setClosed((c) => pushClosed(c, gone.url));
    const rest = t.filter((x) => x.key !== key);
    setActive((a) => (a === key ? rest.at(-1)?.key ?? "" : a));
    return rest;
  }), []);
  const reopen = () => setClosed((c) => { const url = c.at(-1); if (url) setTimeout(() => open(url)); return c.slice(0, -1); });
  const [shot, setShot] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const b = bridge().browser;
    const offs = [
      b.onNewTab(({ requestId, url, sessionId: owner }) => { if (owner && owner !== sessionId) return; onWantVisible(); open(url, requestId); }),
      b.onCloseTab(({ webContentsId }) => setTabs((t) => { const x = t.find((y) => y.wcId === webContentsId); if (x) setTimeout(() => close(x.key)); return t; })),
      b.onActivateTab(({ webContentsId }) => setTabs((t) => { const x = t.find((y) => y.wcId === webContentsId); if (x) setActive(x.key); return t; })),
      b.onOpenUrl(({ url }) => open(url)),
    ];
    return () => offs.forEach((o) => o());
  }, [open, close, onWantVisible, sessionId]);

  const cur = tabs.find((t) => t.key === active);
  useEffect(() => { if (cur?.wcId) void bridge().browser.register(cur.wcId, undefined, sessionId, true).catch(() => {}); }, [cur?.wcId, sessionId]);
  useEffect(() => { setAddress(cur?.url ?? ""); }, [cur?.key, cur?.url]);
  useEffect(() => { if (visible && !tabs.length) open("about:blank"); }, [visible, tabs.length, open]);

  const nav = (fn: (w: any) => void) => { const w = document.querySelector(`.webview-slot[data-key="${active}"] webview`) as any; if (w) fn(w); };

  return (
    <div className="browser" style={{ display: visible ? "flex" : "none" }}>
      <div className="tabbar" role="tablist">
        {tabs.map((t) => (
          <div key={t.key} role="tab" aria-selected={t.key === active} className={`btab ${t.key === active ? "on" : ""}`} onClick={() => setActive(t.key)}>
            <span className="btab-title">{t.title || t.url || "New tab"}</span>
            <button aria-label="Close tab" onClick={(e) => { e.stopPropagation(); close(t.key); }}>x</button>
          </div>
        ))}
        <button className="btab-new" aria-label="New tab" onClick={() => open("about:blank")}>+</button>
        <button aria-label="Reopen closed tab" disabled={!closed.length} onClick={reopen}>Reopen</button>
        <button aria-label="Previous tab" disabled={tabs.length < 2} onClick={() => setActive(stepTab(tabs.map((t) => t.key), active, -1))}>Prev</button>
        <button aria-label="Next tab" disabled={tabs.length < 2} onClick={() => setActive(stepTab(tabs.map((t) => t.key), active, 1))}>Next</button>
        <button aria-label="Move tab left" disabled={tabs.findIndex((t) => t.key === active) < 1} onClick={() => setTabs((t) => moveTab(t, active, -1))}>Move left</button>
        <button aria-label="Move tab right" disabled={tabs.findIndex((t) => t.key === active) >= tabs.length - 1} onClick={() => setTabs((t) => moveTab(t, active, 1))}>Move right</button>
      </div>
      <div className="addrbar">
        <button disabled={!cur?.canBack} onClick={() => nav((w) => w.goBack())} aria-label="Back">Back</button>
        <button disabled={!cur?.canForward} onClick={() => nav((w) => w.goForward())} aria-label="Forward">Forward</button>
        <button onClick={() => nav((w) => (cur?.loading ? w.stop() : w.reload()))}>{cur?.loading ? "Stop" : "Reload"}</button>
        <input value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const u = normalize(address); nav((w) => w.loadURL(u)); } }} aria-label="Address" placeholder="Enter a URL or search" />
        <button disabled={cur?.wcId == null} onClick={() => cur?.wcId != null && void bridge().browser.screenshot(cur.wcId).then(setShot).catch(() => {})} title="Take a screenshot of this tab">Screenshot</button>
        <button onClick={() => void bridge().browser.clearData()} title="Clear cache and cookies">Clear data</button>
        <button onClick={() => setImporting(true)} title="Copy cookies of chosen sites from Chrome into this pane">Import cookies</button>
      </div>
      <div className="webviews">
        {tabs.map((t) => <div key={t.key} className="webview-slot" data-key={t.key} style={{ display: t.key === active ? "flex" : "none" }}><WebviewTab tab={t} sessionId={sessionId} onState={patch} onGone={close} /></div>)}
        {!tabs.length && <div className="empty">No tabs</div>}
      </div>
      {importing && <CookieImportDialog onClose={() => setImporting(false)} />}
      {shot && <div className="overlay" onClick={() => setShot("")}><div className="dialog wide" role="dialog" aria-label="Screenshot" onClick={(e) => e.stopPropagation()}><img src={shot} alt="Screenshot of the tab" style={{ maxWidth: "100%" }} /><div className="dialog-actions"><a href={shot} download="screenshot.png">Save</a><button onClick={() => setShot("")}>Close</button></div></div></div>}
    </div>
  );
}

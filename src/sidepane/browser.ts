// Browser pane control, daemon side (spec §17.3). The desktop app owns the visible browser (an Electron webview) and
// exposes it through a loopback CDP endpoint; this module is the agent's hands: it speaks the Chrome DevTools Protocol
// over that WebSocket and offers one tool, `Browser`, to the session. It works against any CDP browser endpoint, which
// is how the tests drive headless Chromium without Electron.
//
// Accepted endpoint (spec §17.3): scheme ws, host 127.0.0.1, port equal to the desktop's port, path
// /devtools/browser/<id>, no credentials, no hash.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolOutput } from "../core/types.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { rigwellHome } from "../storage/paths.ts";

export const BROWSER_IDLE_MS = 30 * 60_000;

/** Validates a CDP URL; returns the normalized string or throws RpcError. */
export function validateCdpUrl(raw: unknown, expectedPort?: number): string {
  const fail = (m: string) => new RpcError(ErrorCodes.INVALID_PARAMS, `Rejected browser endpoint: ${m}`);
  if (typeof raw !== "string") throw fail("not a string");
  let u: URL;
  try { u = new URL(raw); } catch { throw fail("not a URL"); }
  if (u.protocol !== "ws:") throw fail("scheme must be ws");
  if (u.hostname !== "127.0.0.1") throw fail("host must be 127.0.0.1");
  if (expectedPort !== undefined && Number(u.port) !== expectedPort) throw fail("unexpected port");
  if (u.username || u.password) throw fail("credentials are not allowed");
  if (u.hash) throw fail("hash is not allowed");
  if (u.search) throw fail("query is not allowed");
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(u.pathname)) throw fail("path must be /devtools/browser/<id>");
  return u.toString();
}

type Pending = { resolve(v: any): void; reject(e: Error): void; method: string };

/** A minimal CDP client: request/response over one WebSocket, plus events by method name. */
export class CdpConnection {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  closed = false;
  onClose?: () => void;

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const c = new CdpConnection();
    c.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), timeoutMs);
      c.ws.onopen = () => { clearTimeout(t); resolve(); };
      c.ws.onerror = () => { clearTimeout(t); reject(new Error(`Could not connect to ${url}`)); };
    });
    c.ws.onmessage = (ev) => c.onMessage(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    c.ws.onclose = () => {
      c.closed = true;
      for (const p of c.pending.values()) p.reject(new Error(`Browser connection closed during ${p.method}`));
      c.pending.clear();
      c.onClose?.();
    };
    return c;
  }

  private onMessage(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? "CDP error"}`));
      else p.resolve(m.result ?? {});
    } else if (m.method) {
      for (const l of this.listeners) l(m.method, m.params, m.sessionId);
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(l: (method: string, params: any, sessionId?: string) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }

  close() { this.closed = true; try { this.ws.close(); } catch {} }
}

// Runs in the page: numbers interactive elements and returns a compact description.
const SNAPSHOT_JS = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  document.querySelectorAll('[data-rw-ref]').forEach(e => e.removeAttribute('data-rw-ref'));
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    n++;
    el.setAttribute('data-rw-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const label = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('value') || el.getAttribute('name') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const val = ('value' in el && el.value !== undefined && tag !== 'button') ? String(el.value).slice(0, 60) : '';
    items.push({ ref: n, tag, type, label, value: val, href: el.getAttribute('href') || undefined, checked: el.checked === true ? true : undefined });
    if (n >= 150) break;
  }
  const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000);
  return JSON.stringify({ url: location.href, title: document.title, text, items });
})()`;

export interface TabInfo { id: string; title: string; url: string; active: boolean }

export class BrowserService {
  private conn?: CdpConnection;
  private sessions = new Map<string, string>(); // targetId -> CDP sessionId
  private activeTarget?: string;
  private idleTimer?: ReturnType<typeof setTimeout>;
  readonly screenshotDir: string;

  constructor(private opts: { cdpUrl: string; idleMs?: number; screenshotDir?: string; log?: (m: string) => void }) {
    this.screenshotDir = opts.screenshotDir ?? join(rigwellHome(), "browser-screenshots");
  }

  get url() { return this.opts.cdpUrl; }
  get connected() { return !!this.conn && !this.conn.closed; }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(), this.opts.idleMs ?? BROWSER_IDLE_MS);
    (this.idleTimer as any).unref?.();
  }

  disconnect() {
    clearTimeout(this.idleTimer);
    this.conn?.close();
    this.conn = undefined;
    this.sessions.clear();
    this.activeTarget = undefined;
  }

  private async cdp(): Promise<CdpConnection> {
    this.touch();
    if (this.conn && !this.conn.closed) return this.conn;
    this.sessions.clear();
    this.conn = await CdpConnection.connect(this.opts.cdpUrl);
    return this.conn;
  }

  async tabs(): Promise<TabInfo[]> {
    const c = await this.cdp();
    const { targetInfos } = await c.send<{ targetInfos: any[] }>("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
    if (!this.activeTarget || !pages.some((p) => p.targetId === this.activeTarget)) this.activeTarget = pages[0]?.targetId;
    return pages.map((p) => ({ id: p.targetId, title: p.title, url: p.url, active: p.targetId === this.activeTarget }));
  }

  async selectTab(id: string) {
    const tabs = await this.tabs();
    if (!tabs.some((t) => t.id === id)) throw new Error(`No tab with id ${id}`);
    this.activeTarget = id;
    const c = await this.cdp();
    await c.send("Target.activateTarget", { targetId: id }).catch(() => {});
  }

  async newTab(url = "about:blank"): Promise<string> {
    const c = await this.cdp();
    const { targetId } = await c.send<{ targetId: string }>("Target.createTarget", { url });
    this.activeTarget = targetId;
    return targetId;
  }

  async closeTab(id?: string) {
    const c = await this.cdp();
    const t = id ?? this.activeTarget;
    if (!t) throw new Error("No tab to close");
    await c.send("Target.closeTarget", { targetId: t });
    this.sessions.delete(t);
    if (this.activeTarget === t) this.activeTarget = undefined;
  }

  /** CDP session id for the active tab (attaches on first use). */
  private async page(): Promise<{ c: CdpConnection; sid: string }> {
    const c = await this.cdp();
    if (!this.activeTarget) await this.tabs();
    if (!this.activeTarget) await this.newTab();
    const target = this.activeTarget!;
    let sid = this.sessions.get(target);
    if (!sid) {
      const r = await c.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
      sid = r.sessionId;
      this.sessions.set(target, sid);
      await c.send("Page.enable", {}, sid);
      await c.send("Runtime.enable", {}, sid);
    }
    return { c, sid };
  }

  async evaluate(expression: string): Promise<any> {
    const { c, sid } = await this.page();
    const r = await c.send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return r.result?.value;
  }

  /** Navigates and waits for the load event (or a 15 s cap). */
  async navigate(url: string) {
    const { c, sid } = await this.page();
    const loaded = new Promise<void>((resolve) => {
      const off = c.on((m, _p, s) => { if (s === sid && m === "Page.loadEventFired") { off(); resolve(); } });
      setTimeout(() => { off(); resolve(); }, 15_000);
    });
    const r = await c.send<any>("Page.navigate", { url }, sid);
    if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
    await loaded;
  }

  async history(delta: -1 | 1) {
    const { c, sid } = await this.page();
    const h = await c.send<any>("Page.getNavigationHistory", {}, sid);
    const e = h.entries[h.currentIndex + delta];
    if (!e) throw new Error(delta < 0 ? "No page to go back to" : "No page to go forward to");
    await c.send("Page.navigateToHistoryEntry", { entryId: e.id }, sid);
    await Bun.sleep(150);
  }

  async snapshot() {
    return JSON.parse(await this.evaluate(SNAPSHOT_JS)) as { url: string; title: string; text: string; items: { ref: number; tag: string; type?: string; label: string; value: string; href?: string; checked?: boolean }[] };
  }

  private async center(ref: number): Promise<{ x: number; y: number }> {
    const r = await this.evaluate(`(() => { const el = document.querySelector('[data-rw-ref="${Math.floor(ref)}"]'); if (!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const b = el.getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    if (!r) throw new Error(`No element with ref ${ref}; take a new snapshot`);
    return r;
  }

  async click(ref: number) {
    const { c, sid } = await this.page();
    const { x, y } = await this.center(ref);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sid);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
    await Bun.sleep(150);
  }

  async type(ref: number, text: string, opts: { clear?: boolean; submit?: boolean } = {}) {
    const { c, sid } = await this.page();
    await this.evaluate(`(() => { const el = document.querySelector('[data-rw-ref="${Math.floor(ref)}"]'); if (!el) throw new Error('No element with ref ${ref}; take a new snapshot'); el.scrollIntoView({block:'center'}); el.focus(); ${opts.clear ? "if ('select' in el) el.select();" : ""} })()`);
    if (opts.clear) await this.press("Backspace");
    await c.send("Input.insertText", { text }, sid);
    if (opts.submit) await this.press("Enter");
  }

  async press(key: string) {
    const { c, sid } = await this.page();
    const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 };
    const code = codes[key];
    const text = key === "Enter" ? "\r" : key.length === 1 ? key : undefined;
    const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code ?? key.toUpperCase().charCodeAt(0) };
    await c.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) }, sid);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid);
    await Bun.sleep(100);
  }

  async screenshot(): Promise<string> {
    const { c, sid } = await this.page();
    const r = await c.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sid);
    mkdirSync(this.screenshotDir, { recursive: true });
    const file = join(this.screenshotDir, `shot-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }
}

/** Services by session id: the app attaches a CDP endpoint per session, the Browser tool looks it up. */
export class BrowserRegistry {
  private by = new Map<string, BrowserService>();
  constructor(private opts: { expectedPort?: number; defaultUrl?: string; idleMs?: number; screenshotDir?: string; log?: (m: string) => void } = {}) {}

  attach(sessionId: string, rawUrl: unknown): { attached: true } {
    const url = validateCdpUrl(rawUrl, this.opts.expectedPort);
    this.by.get(sessionId)?.disconnect();
    this.by.set(sessionId, new BrowserService({ cdpUrl: url, idleMs: this.opts.idleMs, screenshotDir: this.opts.screenshotDir, log: this.opts.log }));
    return { attached: true };
  }

  detach(sessionId: string) { this.by.get(sessionId)?.disconnect(); this.by.delete(sessionId); return {}; }

  get(sessionId: string): BrowserService | undefined {
    const s = this.by.get(sessionId);
    if (s) return s;
    if (this.opts.defaultUrl) {
      try { this.attach(sessionId, this.opts.defaultUrl); return this.by.get(sessionId); } catch {}
    }
    return undefined;
  }

  closeAll() { for (const s of this.by.values()) s.disconnect(); this.by.clear(); }
}

const fail = (content: string): ToolOutput => ({ content, isError: true });

function renderSnapshot(s: Awaited<ReturnType<BrowserService["snapshot"]>>): string {
  const lines = s.items.map((i) => {
    const kind = i.tag === "input" ? `input:${i.type ?? "text"}` : i.tag;
    return `[${i.ref}] ${kind}${i.label ? ` "${i.label}"` : ""}${i.value ? ` value="${i.value}"` : ""}${i.href ? ` -> ${i.href}` : ""}${i.checked ? " (checked)" : ""}`;
  });
  return `Page: ${s.title || "(untitled)"}\nURL: ${s.url}\n\nInteractive elements:\n${lines.join("\n") || "(none)"}\n\nVisible text:\n${s.text || "(empty)"}`;
}

/** The agent-facing tool (spec §17.3). Category "other": it changes browser state, never files. */
export function createBrowserTool(registry: BrowserRegistry): Tool {
  return {
    name: "Browser",
    category: "other",
    description:
      "Drive the browser pane the user sees beside this session. Actions: tabs (list), open (new tab, optional url), select_tab (tab), close_tab, " +
      "navigate (url), back, forward, snapshot (page text plus numbered interactive elements), click (ref), type (ref, text, optional clear and submit), " +
      "press (key such as Enter or Tab), screenshot (saves a PNG and returns its path), evaluate (JavaScript expression, result as JSON). " +
      "Element refs come from the latest snapshot and are only valid until the page changes; take a new snapshot after navigating or clicking.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["tabs", "open", "select_tab", "close_tab", "navigate", "back", "forward", "snapshot", "click", "type", "press", "screenshot", "evaluate"] },
        url: { type: "string" }, tab: { type: "string" }, ref: { type: "number" }, text: { type: "string" }, key: { type: "string" },
        expression: { type: "string" }, clear: { type: "boolean" }, submit: { type: "boolean" },
      },
      required: ["action"],
    },
    async run(input, ctx) {
      const b = registry.get(ctx.sessionId);
      if (!b) return fail("The browser pane is not open for this session. Ask the user to open the Browser tab in the side pane.");
      const a = String(input.action ?? "");
      try {
        switch (a) {
          case "tabs": return { content: JSON.stringify(await b.tabs(), null, 1) };
          case "open": { const id = await b.newTab(typeof input.url === "string" ? input.url : undefined); return { content: `Opened tab ${id}` }; }
          case "select_tab": await b.selectTab(String(input.tab ?? "")); return { content: "Selected." };
          case "close_tab": await b.closeTab(typeof input.tab === "string" ? input.tab : undefined); return { content: "Closed." };
          case "navigate": {
            if (typeof input.url !== "string" || !input.url) return fail("url is required.");
            await b.navigate(input.url);
            return { content: renderSnapshot(await b.snapshot()) };
          }
          case "back": await b.history(-1); return { content: renderSnapshot(await b.snapshot()) };
          case "forward": await b.history(1); return { content: renderSnapshot(await b.snapshot()) };
          case "snapshot": return { content: renderSnapshot(await b.snapshot()) };
          case "click": {
            if (typeof input.ref !== "number") return fail("ref is required.");
            await b.click(input.ref);
            return { content: renderSnapshot(await b.snapshot()) };
          }
          case "type": {
            if (typeof input.ref !== "number" || typeof input.text !== "string") return fail("ref and text are required.");
            await b.type(input.ref, input.text, { clear: input.clear === true, submit: input.submit === true });
            return { content: renderSnapshot(await b.snapshot()) };
          }
          case "press": {
            if (typeof input.key !== "string") return fail("key is required.");
            await b.press(input.key);
            return { content: renderSnapshot(await b.snapshot()) };
          }
          case "screenshot": return { content: `Saved screenshot to ${await b.screenshot()}` };
          case "evaluate": {
            if (typeof input.expression !== "string") return fail("expression is required.");
            const v = await b.evaluate(input.expression);
            return { content: JSON.stringify(v ?? null), data: v };
          }
          default: return fail(`Unknown action: ${a}`);
        }
      } catch (e) {
        return fail(`Browser ${a} failed: ${(e as Error).message}`);
      }
    },
  };
}

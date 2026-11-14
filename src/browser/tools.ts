import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { BrowserRegistry, BrowserService, createBrowserTool, type CdpConnection } from "../sidepane/browser.ts";
import { contains } from "../sandbox/policy.ts";
import { browserPolicy, browserUrl, resolvedBrowserPath, type BrowserPolicy } from "./policy.ts";
import { launchHeadlessBrowser, type HeadlessBrowser } from "./launch.ts";

const interactive = new Set(["button", "textbox", "searchbox", "link", "checkbox", "radio", "combobox", "slider", "spinbutton", "tab", "menuitem", "switch", "treeitem"]);
const owners = new Map<string, Set<AgentBrowserManager>>();
class AgentPage {
  private refs = new Map<number, number>();
  private off?: () => void;
  private connection?: CdpConnection;
  private sid?: string;
  policy!: BrowserPolicy;
  private workspaceRoot = "";
  constructor(readonly service: BrowserService, readonly owned?: HeadlessBrowser) {}
  async prepare(ctx: ToolContext) {
    this.policy = browserPolicy(ctx.sessionId, ctx.cwd); this.owned?.update(this.policy);
    this.workspaceRoot = resolvedBrowserPath(ctx.cwd);
    // Refresh the selected target: a newly opened desktop pane takes precedence over its hidden fallback.
    await this.service.tabs();
    const { c, sid } = await this.service.pageEndpoint();
    if (this.connection !== c || this.sid !== sid) {
      this.off?.(); this.connection = c; this.sid = sid; this.refs.clear();
      this.off = c.on((method, p, sessionId) => {
        if (method !== "Fetch.requestPaused" || sessionId !== sid) return;
        const allowed = this.policy.canRequest(String(p.request?.url ?? ""));
        void c.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: p.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}) }, sid).catch(() => {});
      });
      await c.send("Network.enable", {}, sid);
      await c.send("Network.setBypassServiceWorker", { bypass: true }, sid);
      await c.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sid);
    }
    const directory = this.outputDirectory(false);
    // Desktop proxy applies the same rules to all request types, including WebSockets and child frames.
    await c.send("Rigwell.setBrowserPolicy", { targetId: (await this.service.tabs()).find((t) => t.active)?.id, allowed: this.policy.allowed, denied: this.policy.denied, writable: this.policy.writable, blockedPaths: this.policy.blockedPaths, downloadPath: directory }, undefined, 2000).catch((e) => {
      if (String(e).includes("wasn't found") || String(e).includes("not found") || String(e).includes("-32601")) return;
      throw e;
    });
    if (this.owned) await c.send("Browser.setDownloadBehavior", { behavior: directory ? "allowAndName" : "deny", ...(directory ? { downloadPath: directory } : {}) });
    else await c.send("Page.setDownloadBehavior", { behavior: directory ? "allow" : "deny", ...(directory ? { downloadPath: directory } : {}) }, sid);
  }
  private outputDirectory(required: boolean): string | undefined {
    const directory = resolvedBrowserPath(this.policy.directory);
    if (!contains(this.workspaceRoot, directory) || !this.policy.canWrite(directory)) {
      if (required) throw new Error("Browser output path is blocked by the file policy"); return;
    }
    mkdirSync(directory, { recursive: true });
    return directory;
  }
  private async command<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const { c, sid } = await this.service.pageEndpoint(); return c.send<T>(method, params, sid);
  }
  async snapshot() {
    const { nodes } = await this.command<{ nodes: any[] }>("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((n) => [n.nodeId, n])); this.refs.clear();
    const lines: string[] = [], visited = new Set<string>(); let ref = 0;
    const visit = (id: string, depth: number) => {
      const node = byId.get(id); if (!node || visited.has(id) || lines.length >= 300 || depth > 30) return; visited.add(id);
      const role = String(node.role?.value ?? ""), name = String(node.name?.value ?? "");
      if (!node.ignored && !["InlineTextBox", "none", "generic"].includes(role)) {
        let prefix = "";
        if (interactive.has(role) && node.backendDOMNodeId) { this.refs.set(++ref, node.backendDOMNodeId); prefix = `[${ref}] `; }
        const protectedValue = node.properties?.some((p: any) => p.name === "protected" && p.value?.value === true);
        const value = !protectedValue && node.value?.value !== undefined ? ` value=${JSON.stringify(String(node.value.value).slice(0, 300))}` : "";
        lines.push(`${"  ".repeat(Math.min(depth, 12))}${prefix}${role}${name ? ` ${JSON.stringify(name.slice(0, 500))}` : ""}${value}`);
      }
      for (const child of node.childIds ?? []) visit(child, depth + (node.ignored ? 0 : 1));
    };
    if (nodes[0]) visit(nodes[0].nodeId, 0);
    const info = await this.service.evaluate("({url:location.href,title:document.title})");
    return `Page: ${info.title}\nURL: ${info.url}\nAccessibility tree:\n${lines.join("\n").slice(0, 20000)}${lines.length >= 300 ? "\n[Tree truncated]" : ""}`;
  }
  private node(ref: unknown) {
    const id = typeof ref === "number" && Number.isInteger(ref) ? this.refs.get(ref) : undefined;
    if (!id) throw new Error("Unknown element ref; take a new browser_snapshot"); return id;
  }
  async click(ref: unknown) {
    const backendNodeId = this.node(ref);
    await this.command("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { model } = await this.command("DOM.getBoxModel", { backendNodeId });
    const q = model.border as number[]; const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    await this.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  async type(ref: unknown, text: string, clear: boolean) {
    await this.command("DOM.focus", { backendNodeId: this.node(ref) });
    if (clear) await this.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    if (text) await this.command("Input.insertText", { text }); else if (clear) await this.press("Backspace");
  }
  async press(value: string) {
    const parts = value.split("+"); const key = parts.pop()!;
    const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
    let modifiers = 0; for (const p of parts) { if (!modifierBits[p]) throw new Error(`Unknown key modifier ${p}`); modifiers |= modifierBits[p]!; }
    const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageDown: 34, PageUp: 33 };
    if (!key || (key.length > 1 && !codes[key])) throw new Error("Unsupported browser key");
    const text = !modifiers && (key === "Enter" || key.length === 1) ? key === "Enter" ? "\r" : key : undefined;
    const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0), modifiers };
    // macOS headless CDP has no native menu accelerator to translate Command+A.
    const commands = key.toLowerCase() === "a" && modifiers === (process.platform === "darwin" ? 4 : 2) ? ["selectAll"] : undefined;
    await this.command("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...params, ...(text ? { text } : {}), ...(commands ? { commands } : {}) });
    await this.command("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  }
  async scroll(x: number, y: number) { await this.command("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: x, deltaY: y }); }
  async screenshot() {
    const directory = this.outputDirectory(true)!;
    const { data } = await this.command("Page.captureScreenshot", { format: "png" });
    const file = join(directory, `screenshot-${randomUUID()}.png`); if (!this.policy.canWrite(file)) throw new Error("Browser screenshot is blocked by the file policy"); writeFileSync(file, Buffer.from(data, "base64")); return { file, data };
  }
  async close() {
    this.off?.(); this.refs.clear();
    if (this.owned) { this.service.disconnect(); await this.owned.close(); }
    else { await this.service.closeTab(); this.service.disconnect(); }
  }
}

export class AgentBrowserManager {
  private pages = new Map<string, AgentPage>();
  private queues = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  constructor(private panes = new BrowserRegistry(), private opts: { executable?: string; log?: (message: string) => void } = {}) {}
  private async page(ctx: ToolContext) {
    const pane = this.panes.get(ctx.sessionId);
    let page = this.pages.get(ctx.sessionId);
    if (pane && page?.service !== pane) { await page?.close(); page = new AgentPage(pane); this.pages.set(ctx.sessionId, page); }
    if (!page) {
      const owned = await launchHeadlessBrowser(browserPolicy(ctx.sessionId, ctx.cwd), ctx.signal, this.opts);
      page = new AgentPage(new BrowserService({ cdpUrl: owned.url }), owned); this.pages.set(ctx.sessionId, page);
    }
    await page.prepare(ctx); return page;
  }
  async run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    let controller = this.controllers.get(ctx.sessionId);
    if (!controller) { controller = new AbortController(); this.controllers.set(ctx.sessionId, controller); const set = owners.get(ctx.sessionId) ?? new Set(); set.add(this); owners.set(ctx.sessionId, set); }
    ctx = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) };
    const prior = this.queues.get(ctx.sessionId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async (): Promise<ToolOutput> => {
      if (ctx.signal.aborted) return { content: "Browser action cancelled", isError: true };
      try {
        if (name === "browser_close") { const p = this.pages.get(ctx.sessionId); if (p) { await p.close(); this.pages.delete(ctx.sessionId); } return { content: "Browser closed" }; }
        if (name === "Browser" && !this.panes.get(ctx.sessionId)) return createBrowserTool(this.panes).run(input, ctx);
        const p = await this.page(ctx);
        const current = (await p.service.tabs()).find((t) => t.active)?.url;
        const navigates = name === "browser_open" || (name === "Browser" && ["open", "navigate", "close_tab"].includes(String(input.action)));
        if (!navigates && current && !p.policy.canRequest(current)) throw new Error("Current browser page is blocked by the network/file policy");
        switch (name) {
          case "Browser": {
            if (["open", "navigate"].includes(String(input.action))) {
              const url = browserUrl(input.url); if (!p.policy.canRequest(url)) throw new Error("Browser URL is blocked by the network policy");
              if (input.action === "open") { const id = await p.service.newTab(); await p.prepare(ctx); await p.service.navigate(url, ctx.signal); return { content: `Opened tab ${id}` }; }
            }
            if (input.action === "screenshot" && !p.policy.canWrite(p.service.screenshotDir)) throw new Error("Browser screenshot path is blocked by the file policy");
            return createBrowserTool(this.panes).run(input, ctx);
          }
          case "browser_open": { const url = browserUrl(input.url); if (!p.policy.canRequest(url)) throw new Error("Browser URL is blocked by the network policy"); await p.service.navigate(url, ctx.signal); break; }
          case "browser_snapshot": break;
          case "browser_click": await p.click(input.ref); break;
          case "browser_type": if (typeof input.text !== "string") throw new Error("text is required"); await p.type(input.ref, input.text, input.clear !== false); break;
          case "browser_press": if (typeof input.key !== "string") throw new Error("key is required"); await p.press(input.key); break;
          case "browser_scroll": { const x = Number(input.deltaX ?? 0), y = Number(input.deltaY ?? 600); if (![x, y].every((n) => Number.isFinite(n) && Math.abs(n) <= 10000)) throw new Error("Scroll deltas must be bounded numbers"); await p.scroll(x, y); break; }
          case "browser_screenshot": { const shot = await p.screenshot(); return { content: `Saved screenshot to ${shot.file}`, data: { path: shot.file }, ...(ctx.imagesSupported !== false ? { images: [{ type: "image" as const, mediaType: "image/png", data: shot.data }] } : {}) }; }
          case "browser_evaluate": { if (typeof input.expression !== "string") throw new Error("expression is required"); const result = await p.service.evaluate(input.expression); return { content: JSON.stringify(result ?? null), data: result }; }
          case "browser_wait": {
            if (typeof input.text !== "string" || !input.text) throw new Error("text is required");
            const timeout = Number(input.timeoutMs ?? 5000); if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error("timeoutMs must be between 0 and 30000");
            const start = Date.now();
            for (;;) {
              if (ctx.signal.aborted) throw new Error("Browser wait cancelled");
              const snapshot = await p.snapshot(); if (snapshot.includes(input.text)) return { content: snapshot };
              if (Date.now() - start >= timeout) throw new Error("Browser wait timed out before the text appeared"); await Bun.sleep(Math.min(50, timeout));
            }
          }
          default: throw new Error("Unknown browser tool");
        }
        return { content: await p.snapshot() };
      } catch (e) { return { content: `Browser: ${(e as Error).message}`, isError: true }; }
    });
    this.queues.set(ctx.sessionId, pending);
    try { return await pending; } finally { if (this.queues.get(ctx.sessionId) === pending) this.queues.delete(ctx.sessionId); }
  }
  async closeSession(id: string) {
    this.controllers.get(id)?.abort(); await this.queues.get(id)?.catch(() => {});
    const page = this.pages.get(id); this.pages.delete(id); this.controllers.delete(id);
    const set = owners.get(id); set?.delete(this); if (!set?.size) owners.delete(id);
    await page?.close();
  }
  async closeAll() { await Promise.all([...this.controllers.keys()].map((id) => this.closeSession(id))); }
}

export async function closeSessionBrowsers(id: string) { await Promise.all([...(owners.get(id) ?? [])].map((m) => m.closeSession(id))); }
export async function closeAllBrowsers() { await Promise.all([...new Set([...owners.values()].flatMap((s) => [...s]))].map((m) => m.closeAll())); }
export const defaultAgentBrowsers = new AgentBrowserManager();

export function agentBrowserTools(manager: AgentBrowserManager): Tool[] {
  const definitions: [string, string, Record<string, unknown>, string[]][] = [
    ["browser_open", "Open HTTP/HTTPS in this session's pane or headless browser.", { url: { type: "string" } }, ["url"]],
    ["browser_snapshot", "Accessibility tree and refs. Refresh after page changes.", {}, []],
    ["browser_click", "Click a current snapshot ref.", { ref: { type: "integer" } }, ["ref"]],
    ["browser_type", "Type at ref; clear defaults true.", { ref: { type: "integer" }, text: { type: "string" }, clear: { type: "boolean" } }, ["ref", "text"]],
    ["browser_press", "Press a key/chord, e.g. Enter or Control+a.", { key: { type: "string" } }, ["key"]],
    ["browser_scroll", "Scroll pixels, default 600 down; deltas bounded at 10000.", { deltaX: { type: "number" }, deltaY: { type: "number" } }, []],
    ["browser_screenshot", "Save PNG in session folder under file policy.", {}, []],
    ["browser_wait", "Wait for tree text; default timeout 5000 ms.", { text: { type: "string" }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 } }, ["text"]],
    ["browser_evaluate", "Evaluate page JavaScript. Always asks permission.", { expression: { type: "string" } }, ["expression"]],
    ["browser_close", "Close owned browser/current pane tab and release resources.", {}, []],
  ];
  return definitions.map(([name, description, properties, required]) => ({ name, description, category: "other", inputSchema: { type: "object", properties, required, additionalProperties: false }, run: (input, ctx) => manager.run(name, input, ctx) }));
}

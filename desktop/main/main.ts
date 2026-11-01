// Electron main process (spec §14): windows, menu, deep links, the daemon supervisor, the connection broker, the
// browser pane's CDP proxy, notifications and sounds. All agent work stays in the daemon.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, powerSaveBlocker, session, shell, webContents, type IpcMainInvokeEvent, type WebContents } from "electron";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { badgeCount, notificationFor, soundFor, type SoundAction, type WindowState } from "./alerts.ts";
import { initialWindowOptions, overlayFor } from "./appearance.ts";
import { DaemonBroker } from "./broker.ts";
import { startCdpProxy, type CdpProxy, type PaneHost, type PaneTarget } from "./cdp-proxy.ts";
import { browserPermission, buildCsp, isAllowedExternal, isTrustedSender, parseDeepLink } from "./security.ts";
import { loadDesktopSettings, updateDesktopSettings, type DesktopSettings } from "./settings.ts";
import { DaemonSupervisor, START_FAILURE_HINT } from "./supervisor.ts";
import { synthWav } from "./sounds.ts";

// The bundle lives in <app>/dist next to preload.cjs and renderer/. app.getAppPath() is the folder with package.json
// (also correct inside an asar), which is more reliable than __dirname because bundlers may inline that.
const appRoot = /[\\/]dist$/.test(app.getAppPath()) ? join(app.getAppPath(), "..") : app.getAppPath();
const here = join(appRoot, "dist");
const HOME = process.env.RIGWELL_HOME ?? join(homedir(), ".rigwell");
const DEV_URL = process.env.RIGWELL_RENDERER_URL; // optional dev server
const APP_PAGE = DEV_URL ?? new URL(`file://${join(here, "renderer", "index.html")}`).toString();
const SCHEME = "rigwell";
const BROWSER_PARTITION = "persist:browserpanel";

let settings: DesktopSettings = loadDesktopSettings(HOME);
const windows = new Set<BrowserWindow>();
let supervisor: DaemonSupervisor;
let broker: DaemonBroker;
let proxy: CdpProxy | undefined;
let quitting = false;
let blockerId: number | undefined;
const viewing = new Map<number, string | undefined>(); // window webContents id -> session id on screen

// ------------------------------------------------------------------ helpers

const winIds = () => [...windows].map((w) => w.webContents.id);
const trusted = (e: IpcMainInvokeEvent) => !!e.senderFrame && e.senderFrame === e.sender.mainFrame && isTrustedSender(e.senderFrame.url, [APP_PAGE]);
function guard<T>(fn: (e: IpcMainInvokeEvent, ...a: any[]) => T) {
  return (e: IpcMainInvokeEvent, ...a: any[]) => {
    if (!trusted(e)) throw new Error("Untrusted sender");
    return fn(e, ...a);
  };
}
const log = (m: string) => { try { process.stderr.write(m + "\n"); } catch {} };
const sendTo = (id: number, channel: string, payload: unknown) => { const w = webContents.fromId(id); if (w && !w.isDestroyed()) w.send(channel, payload); };
const broadcast = (channel: string, payload: unknown) => { for (const id of winIds()) sendTo(id, channel, payload); };

function windowState(): WindowState {
  const f = BrowserWindow.getFocusedWindow();
  return { focused: !!f, viewingSessionId: f ? viewing.get(f.webContents.id) : undefined };
}

// ------------------------------------------------------------------ attention: notifications, badge, sounds

const toasts = new Map<string, Notification>();
function onAttention(ev: import("../../src/sidepane/attention.ts").AttentionEvent, open: import("../../src/sidepane/attention.ts").AttentionEvent[]) {
  app.setBadgeCount(badgeCount(open));
  if (ev.kind === "attention_resolved") { toasts.get(`session-${ev.sessionId}`)?.close(); return; }
  const w = windowState();
  const n = notificationFor(ev, settings, w);
  if (n && Notification.isSupported()) {
    toasts.get(n.tag)?.close(); // a newer one replaces the older
    const toast = new Notification({ title: n.title, body: n.body, silent: true });
    toast.on("click", () => openRoute(n.route));
    toasts.set(n.tag, toast);
    toast.show();
  }
  const snd = soundFor(ev, settings, w);
  if (snd) void playSound(snd);
}

async function soundUrl(a: SoundAction): Promise<string | undefined> {
  if (a.kind === "bell") return undefined;
  if (a.kind === "builtin") return `data:audio/wav;base64,${synthWav(a.id).toString("base64")}`;
  try {
    const st = statSync(a.path);
    if (!st.isFile() || st.size > 25 * 1024 * 1024) return undefined;
    const ext = a.path.toLowerCase().split(".").pop();
    const mime = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : "audio/wav";
    return `data:${mime};base64,${readFileSync(a.path).toString("base64")}`;
  } catch { return undefined; }
}
async function playSound(a: SoundAction) {
  const url = await soundUrl(a);
  const target = BrowserWindow.getFocusedWindow() ?? [...windows][0];
  target?.webContents.send("audio:play", { kind: a.kind, url, volume: a.volume });
}

// ------------------------------------------------------------------ windows

function createWindow(route = "/"): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors;
  const initial = initialWindowOptions(settings.appearance, dark, process.platform);
  nativeTheme.themeSource = initial.themeSource; // before the window exists, so native chrome matches
  const b = settings.windowBounds;
  const win = new BrowserWindow({
    width: b?.width ?? 1200, height: b?.height ?? 800, ...(b?.x !== undefined ? { x: b.x, y: b.y } : {}),
    minWidth: 720, minHeight: 480,
    show: false,
    backgroundColor: initial.backgroundColor,
    ...initial.titleBar,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
      additionalArguments: [`--rigwell-boot=${Buffer.from(JSON.stringify(initial.boot)).toString("base64")}`],
      spellcheck: true,
    },
  });
  windows.add(win);
  const id = win.webContents.id;
  win.once("ready-to-show", () => { if (b?.maximized) win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternal(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!isTrustedSender(url, [APP_PAGE])) { e.preventDefault(); if (isAllowedExternal(url)) void shell.openExternal(url); } });
  // A reload or navigation drops this window's daemon connections; its terminals live on in the daemon (spec 17.2).
  win.webContents.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) { broker.closeWindow(id); viewing.delete(id); } });
  win.webContents.on("render-process-gone", (_e, d) => log(`[window] renderer gone: ${d.reason}`));
  win.on("unresponsive", () => log("[window] unresponsive"));
  win.webContents.on("did-finish-load", () => { win.webContents.setZoomLevel(settings.windowZoomLevel); });
  win.on("close", () => {
    if (windows.size === 1) { const bb = win.getNormalBounds(); settings = updateDesktopSettings(HOME, { windowBounds: { ...bb, maximized: win.isMaximized() } }); }
  });
  win.on("closed", () => { windows.delete(win); broker.closeWindow(id); viewing.delete(id); browserTabs.forEach((t, k) => { if (t.host === id) browserTabs.delete(k); }); });
  void win.loadURL(`${APP_PAGE}#${route}`);
  return win;
}

function openRoute(route: string) {
  const w = BrowserWindow.getFocusedWindow() ?? [...windows][0];
  if (!w) { createWindow(route); return; }
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  w.webContents.send("nav:go", route);
}

// ------------------------------------------------------------------ browser pane (webviews) + CDP proxy

const browserTabs = new Map<number, { wc: WebContents; host: number }>();
const pendingTabs = new Map<string, (wc: WebContents) => void>();

function paneTarget(wc: WebContents): PaneTarget {
  return {
    id: String(wc.id),
    url: () => wc.getURL(), title: () => wc.getTitle(),
    attach() { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); },
    detach() { /* kept attached: other CDP sessions may share it */ },
    send: (method, params) => wc.debugger.sendCommand(method, params),
    onEvent(cb) {
      const f = (_e: unknown, method: string, params: unknown) => cb(method, params);
      wc.debugger.on("message", f);
      return () => wc.debugger.removeListener("message", f);
    },
  };
}

const paneHost: PaneHost = {
  targets: () => [...browserTabs.values()].filter((t) => !t.wc.isDestroyed()).map((t) => paneTarget(t.wc)),
  async createTab(url) {
    const host = [...windows][0];
    if (!host) throw new Error("No window is open");
    const requestId = crypto.randomUUID();
    const got = new Promise<WebContents>((resolveTab, reject) => {
      pendingTabs.set(requestId, resolveTab);
      setTimeout(() => { if (pendingTabs.delete(requestId)) reject(new Error("The browser pane did not open a tab. Open the Browser tab first.")); }, 10_000);
    });
    host.webContents.send("browser:new-tab", { requestId, url });
    return paneTarget(await got);
  },
  async closeTab(id) {
    const t = browserTabs.get(Number(id));
    if (t) sendTo(t.host, "browser:close-tab", { webContentsId: Number(id) });
  },
  activateTab(id) {
    const t = browserTabs.get(Number(id));
    if (t) sendTo(t.host, "browser:activate-tab", { webContentsId: Number(id) });
  },
};

function setupBrowserSession() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const verdict = browserPermission(permission);
    if (verdict === "allow") return cb(true);
    if (verdict === "deny") return cb(false);
    const host = (() => { try { return new URL(details.requestingUrl).host; } catch { return "this page"; } })();
    void dialog.showMessageBox({ type: "question", buttons: ["Allow", "Deny"], defaultId: 1, cancelId: 1, message: `${host} wants permission: ${permission}` }).then((r) => cb(r.response === 0));
  });
  ses.setPermissionCheckHandler((_wc, permission) => browserPermission(permission) === "allow");
  ses.setDevicePermissionHandler(() => false);
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle("daemon:isIpcAvailable", guard(() => supervisor.state === "running"));
  ipcMain.handle("daemon:getTransportMode", guard(() => "websocket"));
  ipcMain.handle("daemon:getPort", guard(() => (supervisor.info ? Number(new URL(supervisor.info.wsUrl).port) : null)));
  ipcMain.handle("daemon:status", guard(() => broker.lastStatus));
  ipcMain.handle("daemon:restart", guard(async () => { await supervisor.restart(); return supervisor.state; }));
  ipcMain.handle("daemon:open", guard((e) => broker.openConnection(e.sender.id)));
  ipcMain.handle("daemon:sendMessage", guard((e, connId: unknown, message: unknown) => {
    if (typeof connId !== "number" || typeof message !== "string") throw new Error("string messages only");
    broker.send(e.sender.id, connId, message);
  }));
  ipcMain.handle("daemon:close", guard((e, connId: number) => broker.closeConnection(e.sender.id, connId)));

  ipcMain.handle("deeplink:claim", guard((e, state: string) => { claims.set(String(state), { windowId: e.sender.id, at: Date.now() }); }));
  ipcMain.handle("view:set", guard((e, sessionId: string | null) => { viewing.set(e.sender.id, sessionId ?? undefined); }));

  ipcMain.handle("settings:get", guard(() => settings));
  ipcMain.handle("settings:update", guard((_e, patch: unknown) => {
    settings = updateDesktopSettings(HOME, patch);
    nativeTheme.themeSource = settings.appearance.theme;
    const overlay = overlayFor(settings.appearance, nativeTheme.shouldUseDarkColors);
    for (const w of windows) {
      w.setBackgroundColor(overlay.color);
      if (process.platform !== "darwin") (w as any).setTitleBarOverlay?.(overlay);
    }
    applyKeepAwake();
    broadcast("settings:changed", settings);
    return settings;
  }));

  ipcMain.handle("dialog:pickFolder", guard(async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  }));
  ipcMain.handle("dialog:pickFile", guard(async (e, filters?: { name: string; extensions: string[] }[]) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, { properties: ["openFile"], filters });
    return r.canceled ? null : r.filePaths[0];
  }));
  ipcMain.handle("shell:openExternal", guard((_e, url: string) => { if (!isAllowedExternal(url)) throw new Error("Link not allowed"); return shell.openExternal(url); }));
  ipcMain.handle("shell:openPath", guard((_e, p: string) => shell.openPath(resolve(p))));
  ipcMain.handle("alerts:test", guard((_e, kind: "awaiting" | "completion") => {
    const a = soundFor({ kind: "attention_requested", requestKind: kind === "awaiting" ? "permission" : "session_completion", sessionId: "test", summary: "", detail: "", at: Date.now() }, { ...settings, sounds: { ...settings.sounds, soundFocusMode: "always" } }, { focused: true });
    if (a) void playSound(a);
    return !!a;
  }));
  ipcMain.handle("app:info", guard(() => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, home: HOME, daemon: { state: supervisor.state, pid: supervisor.pid ?? null },
  })));

  // Browser pane
  ipcMain.handle("browser:cdpUrl", guard(() => proxy?.url ?? null));
  ipcMain.handle("browser:register", guard((e, webContentsId: number, requestId?: string) => {
    const wc = webContents.fromId(webContentsId);
    // Only a webview hosted by the calling window may be registered.
    if (!wc || wc.getType() !== "webview" || wc.hostWebContents?.id !== e.sender.id) throw new Error("Not a webview of this window");
    browserTabs.set(wc.id, { wc, host: e.sender.id });
    wc.once("destroyed", () => browserTabs.delete(wc.id));
    if (requestId) pendingTabs.get(requestId)?.(wc), pendingTabs.delete(requestId);
    return true;
  }));
  ipcMain.handle("browser:clearData", guard(async () => { const s = session.fromPartition(BROWSER_PARTITION); await s.clearCache(); await s.clearStorageData(); }));
  ipcMain.handle("browser:screenshot", guard(async (_e, webContentsId: number) => {
    const t = browserTabs.get(webContentsId);
    if (!t) throw new Error("Unknown tab");
    return (await t.wc.capturePage()).toDataURL();
  }));
}

function applyKeepAwake() {
  if (settings.keepAwakeEnabled && blockerId === undefined) blockerId = powerSaveBlocker.start("prevent-app-suspension");
  else if (!settings.keepAwakeEnabled && blockerId !== undefined) { powerSaveBlocker.stop(blockerId); blockerId = undefined; }
}

// ------------------------------------------------------------------ menu

function buildMenu() {
  const send = (route: string) => () => openRoute(route);
  const mac = process.platform === "darwin";
  const tpl: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    { label: "File", submenu: [
      { label: "New Session", accelerator: "CmdOrCtrl+N", click: send("/") },
      { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
      { label: "Settings", accelerator: "CmdOrCtrl+,", click: send("/settings/general") },
      { label: "Copy CLI install command", click: () => { clipboard.writeText("bun install -g rigwell"); } },
      { label: "Check for Updates", click: () => void dialog.showMessageBox({ message: "Updates", detail: "No update feed is configured for this build." }) },
      mac ? { role: "close" as const } : { role: "quit" as const, label: "Exit" },
    ] },
    { role: "editMenu" as const },
    { label: "View", submenu: [
      { role: "reload" as const }, { role: "forceReload" as const }, { type: "separator" as const },
      { role: "zoomIn" as const }, { role: "zoomOut" as const }, { role: "resetZoom" as const }, { type: "separator" as const },
      { role: "togglefullscreen" as const, accelerator: "F11" },
    ] },
    { label: "Window", submenu: [{ role: "minimize" as const, accelerator: "CmdOrCtrl+M" }, { role: "close" as const, accelerator: "CmdOrCtrl+W" }] },
    { label: "Help", submenu: [
      { label: "Network check", click: async () => {
        const ok = supervisor.info ? await fetch(`http://${new URL(supervisor.info.wsUrl).host}/`).then((r) => r.status === 401, () => false) : false;
        void dialog.showMessageBox({ message: ok ? "The background service answers on loopback." : "The background service is not answering." });
      } },
      { label: "Report a bug", click: () => void shell.openPath(join(HOME, "logs")) },
      { label: "About", click: () => void dialog.showMessageBox({ message: `Rigwell ${app.getVersion()}`, detail: `Electron ${process.versions.electron}` }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ------------------------------------------------------------------ deep links

const claims = new Map<string, { windowId: number; at: number }>(); // MCP OAuth state -> window (10 min)
function handleDeepLink(raw: string) {
  const d = parseDeepLink(raw);
  if (!d) return;
  if (d.kind === "navigate") return openRoute(d.route);
  const claim = claims.get(d.state);
  if (!claim || Date.now() - claim.at > 10 * 60_000) return;
  claims.delete(d.state);
  sendTo(claim.windowId, "deeplink:mcp-callback", { code: d.code, state: d.state });
}

// ------------------------------------------------------------------ start

function daemonCommand(): string[] {
  if (process.env.RIGWELL_DAEMON_CMD) return JSON.parse(process.env.RIGWELL_DAEMON_CMD);
  const bun = process.env.RIGWELL_BUN ?? "bun";
  const cli = process.env.RIGWELL_CLI ?? resolve(appRoot, "..", "src", "cli", "main.ts");
  return [bun, cli];
}

async function boot() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${SCHEME}://`));
    if (link) handleDeepLink(link); else openRoute("/");
  });
  app.on("open-url", (e, url) => { e.preventDefault(); handleDeepLink(url); });
  app.setAsDefaultProtocolClient(SCHEME);

  await app.whenReady();
  setupBrowserSession();

  // Security: CSP as a response header for dev-server pages (file:// pages carry it in a meta tag), webview limits.
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": [buildCsp({ daemonPort: supervisor.info ? Number(new URL(supervisor.info.wsUrl).port) : undefined })] } });
  });
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (ev, prefs, params) => {
      // Fixed partition, no preload, no node, and only web pages.
      delete (prefs as any).preload;
      prefs.nodeIntegration = false; prefs.contextIsolation = true; prefs.sandbox = true;
      (prefs as any).partition = BROWSER_PARTITION;
      if (!/^(https?:|about:blank)/i.test(params.src ?? "")) ev.preventDefault();
    });
    // Webview pages must not open windows either: links open as tabs in the pane through the renderer.
    if (wc.getType() === "webview") wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) wc.hostWebContents?.send("browser:open-url", { url }); return { action: "deny" }; });
  });

  proxy = await startCdpProxy({ host: paneHost, log });
  supervisor = new DaemonSupervisor({
    home: HOME, command: daemonCommand(), log,
    env: { RIGWELL_BROWSER_CDP_PORT: String(proxy.port), NODE_OPTIONS: "" },
  });
  broker = new DaemonBroker(() => (supervisor.info ? { wsUrl: supervisor.info.wsUrl, token: supervisor.info.token } : undefined), { deliver: sendTo, onAttention, log });
  const status = (state: string, error?: string) => broker.setStatus({ state, error }, winIds());
  supervisor.on("state", (s) => status(s));
  supervisor.on("restarting", () => status("restarting"));
  supervisor.on("ready", () => { status("running"); });
  supervisor.on("exited", () => broker.closeAll());
  supervisor.on("failed", (err: Error) => {
    status("failed", err.message);
    void dialog.showMessageBox({ type: "error", message: "The background service could not start", detail: err.message });
  });

  registerIpc();
  buildMenu();
  applyKeepAwake();
  createWindow(process.argv.find((a) => a.startsWith("--route="))?.slice(8) ?? "/");
  try { await supervisor.start(); } catch (e) {
    status("failed", (e as Error).message);
    void dialog.showMessageBox({ type: "error", message: "The background service could not start", detail: `${START_FAILURE_HINT}\n\n${(e as Error).message}` });
  }
  app.on("activate", () => { if (!windows.size) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true; e.preventDefault();
    broker.closeAll();
    void Promise.all([supervisor.stop(), proxy?.stop()]).finally(() => app.exit(0));
  });
}

void boot();

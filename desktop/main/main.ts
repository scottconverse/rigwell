// Electron main process (spec §14): windows, menu, deep links, the daemon supervisor, the connection broker, the
// browser pane's CDP proxy, notifications and sounds. All agent work stays in the daemon.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, session, shell, Tray, webContents, type IpcMainInvokeEvent, type WebContents } from "electron";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { badgeCount, notificationFor, soundFor, type SoundAction, type WindowState } from "./alerts.ts";
import { initialWindowOptions, overlayFor } from "./appearance.ts";
import { DaemonBroker } from "./broker.ts";
import { daemonCommand as buildDaemonCommand } from "./daemon-cmd.ts";
import { checkForUpdate, describeCheck, type UpdateCheck } from "./update-feed.ts";
import { downloadAndVerify, installAppImage, UpdateRefused } from "./update-verify.ts";
import { dictationStatus, DictationError, transcribe as transcribeSpeech } from "./dictation.ts";
import { readOrgManaged } from "./org-managed.ts";
import { trayModel, type TrayModel } from "./tray.ts";
import { importFromProfile, listChromeProfiles, listCookieDomains, toElectronCookie, userDataDirs, type ChromeProfile } from "../../src/sidepane/chrome-cookies.ts";
import { startCdpProxy, type CdpProxy, type PaneHost, type PaneTarget } from "./cdp-proxy.ts";
import { browserPermission, buildCsp, isAllowedExternal, isTrustedSender, parseDeepLink } from "./security.ts";
import { loadDesktopSettings, updateDesktopSettings, type DesktopSettings } from "./settings.ts";
import { DaemonSupervisor, START_FAILURE_HINT } from "./supervisor.ts";
import { deleteLocalProfile, gitRoot, listProfileViews, readUserSettings, saveLocalProfile, trustFolder, updateUserSettings } from "./user-settings.ts";
import { listSkillViews } from "./skills.ts";
import { synthWav } from "./sounds.ts";
import { freeSlot, saveZoom, stepZoom, zoomFor } from "./window-zoom.ts";

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
const slots = new Map<BrowserWindow, number>(); // window -> zoom slot (window-zoom.json, spec 14.4)
const zooms = new Map<BrowserWindow, number>(); // window -> its current zoom level
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
  updateTray();
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

// ------------------------------------------------------------------ tray (spec 14.2)

let tray: Tray | undefined;
let lastTray: TrayModel | undefined;
const testHooks = process.env.RIGWELL_TEST_HOOKS === "1";
const openedExternal: string[] = [];
const trayIcons = new Map<string, Electron.NativeImage>();
function trayIcon(kind: string) {
  let img = trayIcons.get(kind);
  if (!img) {
    img = nativeImage.createFromPath(join(appRoot, "assets", "tray", `${kind}.png`));
    const big = join(appRoot, "assets", "tray", `${kind}@2x.png`);
    try { img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(big) }); } catch { /* the 1x image is enough */ }
    trayIcons.set(kind, img);
  }
  return img;
}
const anyVisible = () => [...windows].some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized());
function toggleWindows() {
  if (anyVisible()) { for (const w of windows) w.hide(); }
  else if (windows.size) { for (const w of windows) { if (w.isMinimized()) w.restore(); w.show(); } [...windows][0].focus(); }
  else createWindow();
  updateTray();
}
function trayAction(id: string) {
  if (id === "toggle") toggleWindows();
  else if (id === "quit") app.quit();
}
function updateTray() {
  if (!settings.menuBarEnabled) { tray?.destroy(); tray = undefined; lastTray = undefined; return; }
  const m = trayModel({ visible: anyVisible(), active: broker?.activeCount ?? 0, attention: broker?.attentionCount ?? 0 });
  lastTray = m;
  try {
    if (!tray) {
      tray = new Tray(trayIcon(m.icon));
      tray.on("click", () => toggleWindows());
    }
    tray.setImage(trayIcon(m.icon));
    tray.setToolTip(m.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(m.items.map((i): Electron.MenuItemConstructorOptions => ("id" in i ? { id: i.id, label: i.label, enabled: i.enabled !== false, click: () => trayAction(i.id) } : { type: "separator" }))));
  } catch (e) { log(`[tray] unavailable: ${(e as Error).message}`); }
}

if (testHooks) {
  // Playwright reads these through electronApp.evaluate. Only present when the test runner asks for them.
  (globalThis as any).__rigwellTest = {
    tray: () => ({ ...lastTray, created: !!tray, destroyed: tray?.isDestroyed() ?? true }),
    trayClick: (id: string) => trayAction(id),
    opened: () => openedExternal.slice(),
    visibleWindows: () => [...windows].filter((w) => w.isVisible()).length,
  };
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
    ...(process.platform === "linux" ? { icon: join(appRoot, "assets", "icon.png") } : {}),
  });
  windows.add(win);
  slots.set(win, freeSlot(slots.values()));
  const id = win.webContents.id;
  win.once("ready-to-show", () => { if (b?.maximized) win.maximize(); win.show(); updateTray(); });
  win.on("show", () => updateTray()); win.on("hide", () => updateTray());
  win.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternal(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!isTrustedSender(url, [APP_PAGE])) { e.preventDefault(); if (isAllowedExternal(url)) void shell.openExternal(url); } });
  // A reload or navigation drops this window's daemon connections; its terminals live on in the daemon (spec 17.2).
  win.webContents.on("did-start-navigation", (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { broker.closeWindow(id); viewing.delete(id); } });
  win.webContents.on("render-process-gone", (_e, d) => log(`[window] renderer gone: ${d.reason}`));
  win.on("unresponsive", () => log("[window] unresponsive"));
  win.webContents.on("did-finish-load", () => { const l = zoomFor(HOME, slots.get(win) ?? 0, settings.windowZoomLevel); zooms.set(win, l); win.webContents.setZoomLevel(l); });
  // Chromium remembers zoom per URL, and a file: page's route is part of its URL. Moving between routes would pick up
  // another route's level, so this window's own level is put back after every in-page navigation.
  win.webContents.on("did-navigate-in-page", () => { if (zooms.has(win) && !win.isDestroyed()) win.webContents.setZoomLevel(zooms.get(win)!); });
  // Ctrl+wheel zooms this window only; the level is saved for this window's slot.
  win.webContents.on("zoom-changed", (_e, dir) => setWindowZoom(win, stepZoom(win.webContents.getZoomLevel(), dir === "in" ? 1 : -1)));
  win.on("close", () => {
    if (windows.size === 1) { const bb = win.getNormalBounds(); settings = updateDesktopSettings(HOME, { windowBounds: { ...bb, maximized: win.isMaximized() } }); }
  });
  win.on("closed", () => { windows.delete(win); slots.delete(win); zooms.delete(win); broker.closeWindow(id); viewing.delete(id); browserTabs.forEach((t, k) => { if (t.host === id) browserTabs.delete(k); }); });
  void win.loadURL(`${APP_PAGE}#${route}`);
  return win;
}

/** Sets and saves one window's zoom (window-zoom.json, keyed by the window's slot). */
function setWindowZoom(win: BrowserWindow | null | undefined, level: number) {
  if (!win || win.isDestroyed()) return;
  zooms.set(win, level);
  win.webContents.setZoomLevel(level);
  saveZoom(HOME, slots.get(win) ?? 0, level);
}
const zoomStep = (dir: 1 | -1 | 0) => (_item: unknown, from?: Electron.BaseWindow) => { const w = (from instanceof BrowserWindow ? from : undefined) ?? BrowserWindow.getFocusedWindow() ?? [...windows][0]; if (w) setWindowZoom(w, stepZoom(w.webContents.getZoomLevel(), dir)); };

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

  // Agent settings (<home>/settings.json), setup profiles and skills: no daemon method exists for these (secrets stay masked).
  ipcMain.handle("userSettings:get", guard(() => readUserSettings(HOME)));
  ipcMain.handle("userSettings:update", guard((_e, patch: unknown) => updateUserSettings(HOME, patch)));
  ipcMain.handle("userSettings:trustFolder", guard((_e, folder: string) => trustFolder(HOME, String(folder))));
  ipcMain.handle("profiles:list", guard(async (_e, folder: string) => { const root = await gitRoot(String(folder)); return { repoRoot: root, profiles: root ? listProfileViews(HOME, root) : [] }; }));
  ipcMain.handle("profiles:save", guard(async (_e, folder: string, p: any) => { const root = await gitRoot(String(folder)); if (!root) throw new Error("Not a git repository"); return saveLocalProfile(HOME, root, p); }));
  ipcMain.handle("profiles:delete", guard(async (_e, folder: string, id: string) => { const root = await gitRoot(String(folder)); if (!root) throw new Error("Not a git repository"); deleteLocalProfile(HOME, root, String(id)); }));
  ipcMain.handle("skills:list", guard((_e, cwd: string) => listSkillViews(String(cwd))));

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
  ipcMain.handle("shell:openExternal", guard((_e, url: string) => {
    if (!isAllowedExternal(url)) throw new Error("Link not allowed");
    if (testHooks) { openedExternal.push(url); return; } // the test runner follows the link itself
    return shell.openExternal(url);
  }));
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

  // Org-managed settings labels, tray setting, dictation and Chrome cookie import
  ipcMain.handle("org:managed", guard(() => readOrgManaged()));
  ipcMain.handle("tray:refresh", guard(() => { updateTray(); }));
  ipcMain.handle("dictation:status", guard(() => dictationStatus(settings.dictation)));
  ipcMain.handle("dictation:transcribe", guard(async (_e, audio: unknown) => {
    if (!(audio instanceof Uint8Array) && !(audio instanceof ArrayBuffer)) throw new Error("audio must be bytes");
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    if (bytes.length > 64 * 1024 * 1024) throw new Error("The recording is too long");
    try { return { text: await transcribeSpeech(bytes, settings.dictation) }; } catch (e) {
      if (e instanceof DictationError) return { error: e.message, code: e.code };
      throw e;
    }
  }));

  const chromeRoots = () => process.env.RIGWELL_CHROME_USER_DATA_DIR ? [{ browser: "chrome" as const, dir: process.env.RIGWELL_CHROME_USER_DATA_DIR }] : userDataDirs();
  const chromeProfile = (key: unknown): ChromeProfile => {
    const p = listChromeProfiles(chromeRoots()).find((x) => `${x.browser}:${x.dir}` === key);
    if (!p) throw new Error("That browser profile was not found");
    return p;
  };
  ipcMain.handle("cookies:profiles", guard(() => listChromeProfiles(chromeRoots()).map((p) => ({ key: `${p.browser}:${p.dir}`, browser: p.browser, name: p.name, dir: p.dir }))));
  ipcMain.handle("cookies:domains", guard((_e, key: unknown) => listCookieDomains(chromeProfile(key).cookiesFile)));
  // Explicit user action only: the page calls this from the Import button. Only the chosen domains are read, values are never logged.
  ipcMain.handle("cookies:import", guard(async (_e, key: unknown, domains: unknown) => {
    if (!Array.isArray(domains) || !domains.length || !domains.every((d) => typeof d === "string" && d.length < 256)) throw new Error("Choose at least one domain");
    const r = importFromProfile(chromeProfile(key), domains as string[]);
    const ses = session.fromPartition(BROWSER_PARTITION);
    let imported = 0, failed = 0;
    for (const c of r.cookies) { try { await ses.cookies.set(toElectronCookie(c)); imported++; } catch { failed++; } }
    log(`[cookies] imported ${imported} cookies for ${domains.length} domain(s); ${r.skipped + failed} skipped`);
    return { imported, skipped: r.skipped + failed, keySource: r.keySource };
  }));

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

// ------------------------------------------------------------------ updates (spec 14.5)

const feedUrl = () => process.env.RIGWELL_UPDATE_URL || settings.updateFeedUrl;
let lastOffered: string | undefined;

/** Checks the configured feed. `manual` shows every outcome; the automatic check only speaks up for a new version. */
async function runUpdateCheck(manual: boolean): Promise<UpdateCheck> {
  const r = await checkForUpdate({ feedUrl: feedUrl(), currentVersion: app.getVersion() });
  log(`update check: ${r.status}${r.status === "available" ? " " + r.version : ""}`);
  if (r.status !== "available") {
    if (manual) void dialog.showMessageBox({ message: "Updates", detail: describeCheck(r) });
    return r;
  }
  if (!manual && lastOffered === r.version) return r;
  lastOffered = r.version;
  const linux = process.platform === "linux";
  const canInstall = app.isPackaged && !linux;
  const choice = await dialog.showMessageBox({
    message: "Update available", detail: describeCheck(r),
    buttons: linux ? (r.downloadUrl ? ["Download and verify", "Later"] : ["OK"]) : canInstall ? ["Download and install", "Later"] : r.downloadUrl ? ["Open download", "Later"] : ["OK"], cancelId: 1,
  });
  if (choice.response !== 0) return r;
  if (linux && r.downloadUrl) {
    // Linux: the artifact is installed only when its Ed25519 signature verifies against the configured public key (update-verify.ts).
    try {
      const v = await downloadAndVerify({ url: r.downloadUrl, publicKey: process.env.RIGWELL_UPDATE_PUBLIC_KEY || settings.updatePublicKey, signature: r.signature, sha512: r.sha512, size: r.size, destDir: join(HOME, "updates") });
      if (process.env.APPIMAGE) {
        installAppImage(v.path, process.env.APPIMAGE);
        const again = await dialog.showMessageBox({ message: "Update installed", detail: `Rigwell ${r.version} was verified and installed. Restart to use it.`, buttons: ["Restart now", "Later"], cancelId: 1 });
        if (again.response === 0) { app.relaunch(); app.quit(); }
      } else {
        void dialog.showMessageBox({ message: "Update verified", detail: `The signature of Rigwell ${r.version} verified. It was saved to ${v.path}; install it from there.` });
        shell.showItemInFolder(v.path);
      }
    } catch (e) {
      log(`update refused: ${(e as Error).message}`);
      void dialog.showMessageBox({ type: "error", message: e instanceof UpdateRefused ? "The update was not installed" : "The update could not be downloaded", detail: String(e instanceof Error ? e.message : e) });
    }
  } else if (canInstall) {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl() });
      autoUpdater.autoDownload = false;
      autoUpdater.on("update-downloaded", () => autoUpdater.quitAndInstall());
      await autoUpdater.checkForUpdates();
      await autoUpdater.downloadUpdate();
    } catch (e) { void dialog.showMessageBox({ type: "error", message: "The update could not be installed", detail: String(e instanceof Error ? e.message : e) }); }
  } else if (r.downloadUrl) void shell.openExternal(r.downloadUrl);
  return r;
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
      { label: "Check for Updates", click: () => void runUpdateCheck(true) },
      mac ? { role: "close" as const } : { role: "quit" as const, label: "Exit" },
    ] },
    { role: "editMenu" as const },
    { label: "View", submenu: [
      { role: "reload" as const }, { role: "forceReload" as const }, { type: "separator" as const },
      { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: zoomStep(1) },
      { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoomStep(-1) },
      { id: "zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoomStep(0) },
      { type: "separator" as const },
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
  return buildDaemonCommand({ env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot });
}

/** Chromium's own background network traffic (component updater, field trials, pings) is not wanted: this app keeps local logs only (spec §14.5). It also stalled startup behind a filtering proxy. */
function quietChromium() {
  if (process.env.RIGWELL_FAKE_AUDIO === "1") for (const sw of ["use-fake-device-for-media-stream", "use-fake-ui-for-media-stream"]) app.commandLine.appendSwitch(sw); // tests: no real microphone
  for (const sw of ["disable-background-networking", "disable-component-update", "disable-sync", "no-pings", "no-default-browser-check"]) app.commandLine.appendSwitch(sw);
  app.commandLine.appendSwitch("disable-features", "OptimizationHints,Translate,MediaRouter,CertificateTransparencyComponentUpdater,AutofillServerCommunication");
}

async function boot() {
  quietChromium();
  // A custom RIGWELL_HOME is a separate Rigwell install: give it its own Electron profile, so its single-instance lock,
  // cookies and window state do not collide with another home's app (also lets parallel test runs coexist).
  if (process.env.RIGWELL_HOME) app.setPath("userData", join(process.env.RIGWELL_HOME, "desktop-profile"));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${SCHEME}://`));
    if (link) handleDeepLink(link); else openRoute("/");
  });
  app.on("open-url", (e, url) => { e.preventDefault(); handleDeepLink(url); });
  app.setAsDefaultProtocolClient(SCHEME);

  await app.whenReady();
  setupBrowserSession();
  // The microphone (voice dictation) is offered to the app's own page only; the browser pane's partition has its own handlers.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permission === "media" && isTrustedSender(details.requestingUrl, [APP_PAGE])));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && isTrustedSender(origin, [APP_PAGE]));

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
  broker = new DaemonBroker(() => (supervisor.info ? { wsUrl: supervisor.info.wsUrl, token: supervisor.info.token } : undefined), { deliver: sendTo, onAttention, onActivity: () => updateTray(), log });
  const status = (state: string, error?: string) => broker.setStatus({ state, error }, winIds());
  supervisor.on("state", (s) => status(s));
  supervisor.on("restarting", () => status("restarting"));
  supervisor.on("ready", () => { status("running"); });
  supervisor.on("exited", () => broker.closeAll(true));
  supervisor.on("failed", (err: Error) => {
    status("failed", err.message);
    void dialog.showMessageBox({ type: "error", message: "The background service could not start", detail: err.message });
  });

  registerIpc();
  buildMenu();
  updateTray();
  applyKeepAwake();
  if (settings.desktopAutoUpdateEnabled && feedUrl()) setTimeout(() => void runUpdateCheck(false), 15_000).unref();
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

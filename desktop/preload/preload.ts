// Preload: one narrow bridge object through contextBridge (spec §14.1). No Node APIs reach the page.
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";

type Cb<T> = (payload: T) => void;
const on = <T>(channel: string, cb: Cb<T>) => {
  const h = (_e: IpcRendererEvent, p: T) => cb(p);
  ipcRenderer.on(channel, h);
  return (): void => { ipcRenderer.removeListener(channel, h); };
};

// Boot values from the main process, passed as a process argument so the page can theme itself before it paints.
function readBoot(): unknown {
  const arg = process.argv.find((a) => a.startsWith("--rigwell-boot="));
  if (!arg) return undefined;
  try { return JSON.parse(Buffer.from(arg.slice("--rigwell-boot=".length), "base64").toString("utf8")); } catch { return undefined; }
}

const api = {
  boot: readBoot(),
  platform: process.platform,
  daemon: {
    isIpcAvailable: (): Promise<boolean> => ipcRenderer.invoke("daemon:isIpcAvailable"),
    getTransportMode: (): Promise<string> => ipcRenderer.invoke("daemon:getTransportMode"),
    getPort: (): Promise<number | null> => ipcRenderer.invoke("daemon:getPort"),
    status: (): Promise<{ state: string; error?: string }> => ipcRenderer.invoke("daemon:status"),
    restart: (): Promise<string> => ipcRenderer.invoke("daemon:restart"),
    open: (): Promise<number> => ipcRenderer.invoke("daemon:open"),
    /** Strings only; the main process rejects anything else. */
    sendMessage: (connId: number, message: string): Promise<void> => ipcRenderer.invoke("daemon:sendMessage", connId, message),
    close: (connId: number): Promise<void> => ipcRenderer.invoke("daemon:close", connId),
    onMessage: (cb: Cb<{ connId: number; message: string }>) => on("daemon:message", cb),
    onClosed: (cb: Cb<{ connId: number }>) => on("daemon:closed", cb),
    onStatus: (cb: Cb<{ state: string; error?: string }>) => on("daemon:status", cb),
  },
  view: { set: (sessionId: string | null): Promise<void> => ipcRenderer.invoke("view:set", sessionId) },
  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke("settings:get"),
    update: (patch: unknown): Promise<unknown> => ipcRenderer.invoke("settings:update", patch),
    onChanged: (cb: Cb<unknown>) => on("settings:changed", cb),
  },
  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),
    pickFile: (filters?: { name: string; extensions: string[] }[]): Promise<string | null> => ipcRenderer.invoke("dialog:pickFile", filters),
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:openExternal", url),
    openPath: (p: string): Promise<string> => ipcRenderer.invoke("shell:openPath", p),
  },
  app: { info: (): Promise<any> => ipcRenderer.invoke("app:info"), testSound: (kind: "awaiting" | "completion"): Promise<boolean> => ipcRenderer.invoke("alerts:test", kind) },
  audio: { onPlay: (cb: Cb<{ kind: string; url?: string; volume: number }>) => on("audio:play", cb) },
  nav: { onGo: (cb: Cb<string>) => on("nav:go", cb) },
  deeplink: { claim: (state: string): Promise<void> => ipcRenderer.invoke("deeplink:claim", state), onMcpCallback: (cb: Cb<{ code: string; state: string }>) => on("deeplink:mcp-callback", cb) },
  zoom: { get: () => webFrame.getZoomLevel(), set: (l: number) => webFrame.setZoomLevel(l) },
  browser: {
    cdpUrl: (): Promise<string | null> => ipcRenderer.invoke("browser:cdpUrl"),
    register: (webContentsId: number, requestId?: string): Promise<boolean> => ipcRenderer.invoke("browser:register", webContentsId, requestId),
    clearData: (): Promise<void> => ipcRenderer.invoke("browser:clearData"),
    screenshot: (webContentsId: number): Promise<string> => ipcRenderer.invoke("browser:screenshot", webContentsId),
    onNewTab: (cb: Cb<{ requestId: string; url: string }>) => on("browser:new-tab", cb),
    onCloseTab: (cb: Cb<{ webContentsId: number }>) => on("browser:close-tab", cb),
    onActivateTab: (cb: Cb<{ webContentsId: number }>) => on("browser:activate-tab", cb),
    onOpenUrl: (cb: Cb<{ url: string }>) => on("browser:open-url", cb),
  },
};

contextBridge.exposeInMainWorld("rigwell", api);
export type RigwellBridge = typeof api;

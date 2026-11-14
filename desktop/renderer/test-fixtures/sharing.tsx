import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedSessions } from "../components/SharedSessions.tsx";
import { Sync } from "../components/Sync.tsx";
import { PhoneAccessPage } from "../components/PhoneAccess.tsx";
import { SessionScreen } from "../components/SessionScreen.tsx";
import { app } from "../lib/app-model.ts";
const sockets = new Map<number, WebSocket>(); let seq = 0;
let deliver: (message: any) => void = () => {}, closed: (message: any) => void = () => {};
const off = () => () => {};
(window as any).rigwell = {
  view: { async set() {} }, browser: { onNewTab: off, onCloseTab: off, onActivateTab: off, onOpenUrl: off, async cdpUrl() { return null; } },
  dialog: { async pickFolder() { return (window as any).fixtureFolder; }, async pickFile() { return (window as any).fixtureSource; }, async saveSessionExport(format: string, content: string) { (window as any).savedExport = { format, content }; return '/fixture/saved.html'; } },
  userSettings: { async get() { return {}; } },
  daemon: {
    onMessage(fn: any) { deliver = fn; }, onClosed(fn: any) { closed = fn; },
    async open() {
      const id = ++seq, ws = new WebSocket((window as any).fixtureSocket); sockets.set(id, ws);
      ws.onmessage = (e) => deliver({ connId: id, message: e.data }); ws.onclose = () => closed({ connId: id });
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Fixture socket failed")); }); return id;
    },
    async sendMessage(id: number, text: string) { sockets.get(id)!.send(text); },
    async close(id: number) { sockets.get(id)?.close(); sockets.delete(id); },
  },
};
(app as any).set({ daemon: { state: "running" }, models: [], userSettings: {} });
Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text: string) { (window as any).fixtureClipboard = text; } } });
function Fixture() {
  if (window.location.pathname === "/phone") return <PhoneAccessPage />;
  const [route, go] = useState(window.location.pathname === "/sync" ? "/sync" : "/imports");
  if (route === "/sync") return <Sync go={go} />;
  return route.startsWith("/sessions/") ? <SessionScreen sessionId={route.split("/")[2]!} /> : <SharedSessions id={route.split("/")[2]} go={go} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

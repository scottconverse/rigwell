import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedSessions } from "../components/SharedSessions.tsx";
import { Sync } from "../components/Sync.tsx";
import { PhoneAccessPage } from "../components/PhoneAccess.tsx";
import { DelegationPage } from "../components/Delegation.tsx";
import { Inbox, EmailAlerts } from "../components/Inbox.tsx";
import { Plugins } from "../components/Plugins.tsx";
import { Wiki } from "../components/Wiki.tsx";
import { Academy } from "../components/Academy.tsx";
import { Automations, AutomationDetail } from "../components/Automations.tsx";
import { SessionScreen } from "../components/SessionScreen.tsx";
import { app, useApp } from "../lib/app-model.ts";
import { Sidebar } from "../components/Shell.tsx";
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
function DelegationFixture() {
  const a = useApp(), [route, setRoute] = useState("");
  useEffect(() => { const changed = () => setRoute(window.location.hash.slice(1)); window.addEventListener("hashchange", changed); void app.refresh(); return () => window.removeEventListener("hashchange", changed); }, []);
  return <><Sidebar sessions={a.sessions} daemon="running" go={(r) => { window.location.hash = r; }} openPalette={() => {}} />{route.startsWith("/sessions/") ? <SessionScreen sessionId={route.split("/")[2]!} /> : <DelegationPage />}</>;
}
function Fixture() {
  if (window.location.pathname === "/phone") return <PhoneAccessPage />;
  if (window.location.pathname === "/delegation") return <DelegationFixture />;
  if (window.location.pathname === "/plugins") return <Plugins />;
  if (window.location.pathname === "/wiki") return <Wiki />;
  if (window.location.pathname === "/academy") return <Academy go={(route) => { (window as any).fixtureRoute = route; }} />;
  const [route, go] = useState(window.location.pathname === "/inbox" ? "/inbox" : window.location.pathname === "/sync" ? "/sync" : window.location.pathname === "/automations" ? "/automations" : "/imports");
  if (route === "/inbox") return <Inbox go={go} />;
  if (route === "/settings/email-alerts") return <EmailAlerts />;
  if (route === "/automations") return <Automations go={go} />;
  if (route.startsWith("/automations/")) return <AutomationDetail id={route.split("/")[2]!} go={go} />;
  if (route === "/sync") return <Sync go={go} />;
  return route.startsWith("/sessions/") ? <SessionScreen sessionId={route.split("/")[2]!} /> : <SharedSessions id={route.split("/")[2]} go={go} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

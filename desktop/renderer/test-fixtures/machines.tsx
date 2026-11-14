import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "../components/Home.tsx";
import { RemoteMachines } from "../components/Machines.tsx";
import { SessionScreen } from "../components/SessionScreen.tsx";
import { app } from "../lib/app-model.ts";
const sockets = new Map<number, WebSocket>(); let seq = 0;
let deliver: (message: any) => void = () => {}, closed: (message: any) => void = () => {};
const off = () => () => {};
(window as any).rigwell = {
  view: { async set() {} }, browser: { onNewTab: off, onCloseTab: off, onActivateTab: off, onOpenUrl: off, async cdpUrl() { throw new Error("Remote sessions must not attach local CDP"); } },
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
function Fixture() {
  const [route, go] = useState("/settings/machines");
  return <><nav><button onClick={() => go("/")}>New task</button><button onClick={() => go("/settings/machines")}>Remote settings</button></nav>
    {route === "/settings/machines" ? <RemoteMachines /> : route.startsWith("/sessions/") ? <SessionScreen sessionId={route.split("/")[2]!} /> : <Home go={go} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

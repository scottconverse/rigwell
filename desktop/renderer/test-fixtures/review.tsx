import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Review } from "../components/Review.tsx";
import { app } from "../lib/app-model.ts";
import { live } from "../components/SessionScreen.tsx";

const sockets = new Map<number, WebSocket>(); let seq = 0;
let deliver: (message: any) => void = () => {}, closed: (message: any) => void = () => {};
(window as any).rigwell = { view: { async set() {} }, daemon: {
  onMessage(fn: any) { deliver = fn; }, onClosed(fn: any) { closed = fn; },
  async open() {
    const id = ++seq, ws = new WebSocket((window as any).fixtureSocket); sockets.set(id, ws);
    ws.onmessage = (e) => deliver({ connId: id, message: e.data }); ws.onclose = () => closed({ connId: id });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Fixture socket failed")); }); return id;
  },
  async sendMessage(id: number, text: string) { sockets.get(id)!.send(text); },
  async close(id: number) { sockets.get(id)?.close(); sockets.delete(id); },
} };
(app as any).set({ daemon: { state: "running" } });
function Agent({ id }: { id: string }) {
  const ctl = live.get(id)!, state = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  return <><h1>Agent task</h1><pre>{JSON.stringify(state.items)}</pre></>;
}
function Fixture() {
  const [route, go] = useState("/review");
  return route.startsWith("/sessions/") ? <Agent id={route.split("/")[2]} /> : <Review initialFolder={(window as any).fixtureCwd} go={go} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

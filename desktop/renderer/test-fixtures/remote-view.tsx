import React from "react";
import { createRoot } from "react-dom/client";
import { RemoteViewer } from "../components/RemoteViewer.tsx";
const ws = new WebSocket((window as any).fixtureSocket);
const ready = new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
let seq = 0;
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>(), subscribers = new Set<(event: any) => void>();
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.event) { if (m.event.data) m.event.data = new Uint8Array(m.event.data); for (const fn of subscribers) fn(m.event); return; }
  const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error(m.error)); else p?.resolve(m.result);
};
async function call(method: string, ...args: any[]) {
  await ready; const id = ++seq;
  return new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, args })); });
}
(window as any).rigwell = { remoteView: {
  open: (...args: any[]) => call("open", ...args), receive: (id: string) => call("receive", id),
  send: (id: string, data: Uint8Array) => call("send", id, [...data]), close: (id: string) => call("close", id),
  onData(fn: (event: any) => void) { subscribers.add(fn); return () => subscribers.delete(fn); },
} };
createRoot(document.getElementById("root")!).render(<RemoteViewer machine="fixture" kind="desktop" visible />);

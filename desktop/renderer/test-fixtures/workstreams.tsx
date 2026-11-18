import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Workstreams } from "../components/Workstreams.tsx";
import { live } from "../components/SessionScreen.tsx";
import { app } from "../lib/app-model.ts";
import { SessionController } from "../lib/session.ts";
import { Composer, type ComposerSettings } from "../components/Composer.tsx";
import { Prompts } from "../components/Prompts.tsx";

const sockets = new Map<number, WebSocket>(); let seq = 0;
let deliver: (m: any) => void = () => {}, closed: (m: any) => void = () => {};
(window as any).rigwell = { view: { async set() {} }, daemon: {
  onMessage(fn: any) { deliver = fn; }, onClosed(fn: any) { closed = fn; },
  async open() {
    const id = ++seq, ws = new WebSocket((window as any).fixtureUrl); sockets.set(id, ws);
    ws.onmessage = (e) => deliver({ connId: id, message: e.data }); ws.onclose = () => closed({ connId: id });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Fixture socket failed")); }); return id;
  },
  async sendMessage(id: number, text: string) { sockets.get(id)!.send(text); },
  async close(id: number) { sockets.get(id)?.close(); sockets.delete(id); },
} };
(app as any).set({ daemon: { state: "running" } });
function Transcript({ id, back }: { id: string; back(): void }) {
  const ctl = live.get(id)!, state = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  return <><button onClick={back}>Back to workstream</button><h1>Live transcript</h1><pre>{JSON.stringify(state.items)}</pre></>;
}
function Fixture() {
  const [route, go] = useState("/workstreams"), parts = route.split("/");
  return <><Proposal />{parts[1] === "sessions" ? <Transcript id={parts[2]} back={() => go(`/workstreams/${(window as any).fixtureId}`)} /> : <Workstreams id={parts[2]} go={go} />}</>;
}
function Proposal() {
  const [ctl, setCtl] = useState<SessionController>();
  const profile = { id: "custom:Fake-Anthropic-0", displayName: "Test profile" };
  const [settings, setSettings] = useState<ComposerSettings>({ modelId: profile.id, autonomyLevel: "low" });
  return <>
    {ctl && <ProposalPrompts ctl={ctl} />}
    <Composer models={[profile]} settings={settings} busy={false} onStop={() => {}} onChange={(patch) => setSettings((value) => ({ ...value, ...patch }))}
      onSend={(text) => void (async () => {
        const c = ctl ?? await SessionController.create({ ...settings, cwd: (window as any).fixtureCwd });
        setCtl(c); await c.send(text);
      })()} />
  </>;
}
function ProposalPrompts({ ctl }: { ctl: SessionController }) {
  const s = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  return <Prompts prompts={s.prompts} onAnswer={(id, result) => ctl.answer(id, result)} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

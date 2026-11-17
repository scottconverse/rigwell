import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SideChatTab } from "../components/SideChatTab.tsx";
import type { SessionController } from "../lib/session.ts";

const fixture = (window as any).fixture = { writes: false, requests: [] as boolean[], questions: [] as string[], settle: (_fail: boolean) => {} };
function Fixture() {
  const [writes, setWrites] = useState(false);
  const [prefill, setPrefill] = useState<string>();
  const ctl = { async setSideWrites(enabled: boolean) {
    fixture.requests.push(enabled);
    await new Promise<void>((resolve, reject) => { fixture.settle = (fail: boolean) => fail ? reject(new Error("Fixture refused the change")) : resolve(); });
    fixture.writes = enabled; setWrites(enabled);
  }, async askSide(question: string) { fixture.questions.push(question); } } as SessionController;
  return <><button onClick={() => setPrefill('About this: "you chose rust and zig"\n\n')}>Contextual side chat</button><SideChatTab ctl={ctl} entries={[]} writes={writes} prefill={prefill} onPrefillUsed={() => setPrefill(undefined)} onPromoted={() => {}} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

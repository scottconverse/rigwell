import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SideChatTab } from "../components/SideChatTab.tsx";
import type { SessionController } from "../lib/session.ts";

const fixture = (window as any).fixture = { writes: false, requests: [] as boolean[], settle: (_fail: boolean) => {} };
function Fixture() {
  const [writes, setWrites] = useState(false);
  const ctl = { async setSideWrites(enabled: boolean) {
    fixture.requests.push(enabled);
    await new Promise<void>((resolve, reject) => { fixture.settle = (fail: boolean) => fail ? reject(new Error("Fixture refused the change")) : resolve(); });
    fixture.writes = enabled; setWrites(enabled);
  } } as SessionController;
  return <SideChatTab ctl={ctl} entries={[]} writes={writes} onPrefillUsed={() => {}} onPromoted={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

// Side chat tab (spec §17.4): ask without interrupting the main agent. Answers stream into entries.
import { useEffect, useRef, useState } from "react";
import type { SessionController, SideEntry } from "../lib/session.ts";
import { Markdown } from "./Transcript.tsx";

const STATUS: Record<SideEntry["status"], string> = { pending: "Queued", streaming: "Answering", complete: "", error: "Failed" };

export function SideChatTab({ ctl, entries, prefill, onPrefillUsed }: { ctl: SessionController; entries: SideEntry[]; prefill?: string; onPrefillUsed(): void }) {
  const [q, setQ] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (prefill) { setQ(prefill); onPrefillUsed(); } }, [prefill, onPrefillUsed]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [entries]);
  const ask = async () => { const t = q.trim(); if (!t) return; setQ(""); await ctl.askSide(t).catch(() => {}); };
  return (
    <div className="sidechat">
      <div className="sidechat-list" data-testid="sidechat-list">
        {!entries.length && <div className="empty">Ask a quick question about this session. The main agent keeps working and does not see it.</div>}
        {entries.map((e) => (
          <div key={e.id} className={`sc-entry ${e.status}`}>
            <div className="bubble user">{e.question}</div>
            {e.answer ? <div className="assistant"><Markdown text={e.answer} /></div> : null}
            {STATUS[e.status] && <div className="muted small">{STATUS[e.status]}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="sidechat-input">
        <textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a side question" aria-label="Side question"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
        <button className="primary" disabled={!q.trim()} onClick={() => void ask()}>Ask</button>
      </div>
    </div>
  );
}

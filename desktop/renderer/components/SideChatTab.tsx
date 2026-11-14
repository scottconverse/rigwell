// Side chat tab (spec §17.4): ask without interrupting the main agent. Answers stream into entries.
import { useEffect, useRef, useState } from "react";
import type { SessionController, SideEntry } from "../lib/session.ts";
import { Markdown } from "./Transcript.tsx";

const STATUS: Record<SideEntry["status"], string> = { pending: "Queued", streaming: "Answering", complete: "", error: "Failed" };

export function SideChatTab({ ctl, entries, writes, prefill, onPrefillUsed, onPromoted }: { ctl: SessionController; entries: SideEntry[]; writes: boolean; prefill?: string; onPrefillUsed(): void; onPromoted(sessionId: string): void }) {
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [savingWrites, setSavingWrites] = useState(false);
  const changeWrites = async (enabled: boolean) => {
    setSavingWrites(true); setError("");
    try { await ctl.setSideWrites(enabled); }
    catch (er) { setError((er as Error).message); }
    finally { setSavingWrites(false); }
  };
  const promote = async (id: string) => { setError(""); try { onPromoted(await ctl.promoteSide(id)); } catch (e) { setError((e as Error).message); } };
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (prefill) { setQ(prefill); onPrefillUsed(); } }, [prefill, onPrefillUsed]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [entries]);
  const ask = async () => { const t = q.trim(); if (!t) return; setQ(""); await ctl.askSide(t).catch(() => {}); };
  return (
    <div className="sidechat">
      <div className="sc-tools">
        <label className="check small" title="Off: the side chat can only read. On: it may edit files when you ask it to.">
          <input type="checkbox" checked={writes} disabled={savingWrites} onChange={(e) => void changeWrites(e.target.checked)} />Allow edits in this side chat
        </label>
        {error && <span className="attach-error" role="alert">{error}</span>}
      </div>
      <div className="sidechat-list" data-testid="sidechat-list">
        {!entries.length && <div className="empty">Ask a quick question about this session. The main agent keeps working and does not see it.</div>}
        {entries.map((e) => (
          <div key={e.id} className={`sc-entry ${e.status}`}>
            <div className="bubble user">{e.question}</div>
            {e.answer ? <div className="assistant"><Markdown text={e.answer} /></div> : null}
            {STATUS[e.status] && <div className="muted small">{STATUS[e.status]}</div>}
            {e.status === "complete" && e.forkId && (e.promotedTo
              ? <div className="sc-promote muted small">Promoted to a session <button onClick={() => onPromoted(e.promotedTo!)}>Open</button></div>
              : <div className="sc-promote"><button aria-label="Promote to session" title="Make this side chat a normal session in this project" onClick={() => void promote(e.id)}>Promote to session</button></div>)}
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

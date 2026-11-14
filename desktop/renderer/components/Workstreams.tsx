import { useEffect, useRef, useState } from "react";
import type { AgentEntry, Workstream, WorkstreamMessage } from "../../../src/workstreams/store.ts";
import { useApp } from "../lib/app-model.ts";
import { DaemonConn } from "../lib/rpc.ts";
import { SessionController, type Prompt } from "../lib/session.ts";
import { Dialog } from "./Dialogs.tsx";
import { Prompts } from "./Prompts.tsx";
import { live } from "./SessionScreen.tsx";

interface Detail { workstream: Workstream; roster: AgentEntry[]; messages: WorkstreamMessage[]; pendingPrompts: (Omit<Prompt, "resolve"> & { agentId: string })[] }

export function Workstreams({ id, go }: { id?: string; go(route: string): void }) {
  const a = useApp(), conn = useRef<DaemonConn | undefined>(undefined);
  const [rows, setRows] = useState<(Workstream & { agentCount: number })[]>([]), [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState(""), [loaded, setLoaded] = useState(false);
  const [messageTo, setMessageTo] = useState<AgentEntry>(), [text, setText] = useState(""), [priority, setPriority] = useState("next");
  const [archive, setArchive] = useState<AgentEntry | "workstream">(), [cleanup, setCleanup] = useState(false);
  const [budget, setBudget] = useState(false), [limits, setLimits] = useState<string[]>(["", "", ""]);
  const pull = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (a.daemon.state !== "running") return;
    let dead = false, generation = 0;
    setDetail(undefined); setLoaded(false);
    (async () => {
      try {
        const c = await DaemonConn.open(); if (dead) { c.close(); return; } conn.current = c;
        const load = async () => {
          const g = ++generation;
          try {
            const r = await c.request(id ? "get_workstream" : "list_workstreams", id ? { id } : {});
            if (dead || g !== generation) return;
            if (id) setDetail(r); else setRows(r.workstreams);
            setError(""); setLoaded(true);
          } catch (e) { if (!dead && g === generation) { setError((e as Error).message); setLoaded(true); } }
        };
        pull.current = load;
        c.onNotification = (method, p) => { if (method === "session_notification" && String(p.notification?.type).startsWith("workstream_")) void load(); };
        c.onClose = () => { if (!dead) setError("Workstreams connection closed. Reopen this page to reconnect."); };
        await load();
      } catch (e) { if (!dead) setError((e as Error).message); }
    })();
    return () => { dead = true; generation++; conn.current?.close(); conn.current = undefined; };
  }, [id, a.daemon.state]);
  const act = async (method: string, params: Record<string, unknown> = {}) => {
    try { await conn.current!.request(method, { id, ...params }); await pull.current(); } catch (e) { setError((e as Error).message); }
  };
  const open = async (agent: { sessionId: string; cwd: string; name: string }) => {
    try { if (!live.has(agent.sessionId)) live.set(agent.sessionId, await SessionController.resume(agent.sessionId, agent.cwd, { title: agent.name })); go(`/sessions/${agent.sessionId}`); }
    catch (e) { setError((e as Error).message); }
  };
  const w = detail?.workstream, archived = w?.state === "archived";
  const tokens = detail?.roster.reduce((n, r) => n + r.tokens, 0) ?? 0, cost = detail?.roster.reduce((n, r) => n + r.costUsd, 0) ?? 0;
  return <div className="page">
    <header className="page-head">{id && <button onClick={() => go("/workstreams")}>Back</button>}<h1>{w?.title ?? "Workstreams"}</h1><span className="spacer" />
      {w && <><span className="badge">{w.state}</span><button onClick={() => void open({ sessionId: w.leadSessionId, cwd: w.cwd, name: w.title })}>Open lead</button>
        <button disabled={archived} onClick={() => { if (w.state === "paused") { setLimits([w.budget?.maxTokens, w.budget?.maxCostUsd, w.budget?.maxWallMinutes].map((v) => v == null ? "" : String(v))); setBudget(true); } else void act("pause_workstream"); }}>{w.state === "paused" ? "Resume" : "Pause"}</button>
        <button disabled={archived} onClick={() => { setCleanup(false); setArchive("workstream"); }}>Archive workstream</button></>}
    </header>
    {error && <div className="banner error" role="alert">{error}</div>}
    {!id && <><p className="muted">Ask a lead session to propose a workstream. Review its plan before members start.</p><ul className="plain-list cards" aria-label="Workstreams">{rows.map((r) => <li key={r.id}><button className="card-row" onClick={() => go(`/workstreams/${r.id}`)}><strong>{r.title}</strong><span>{r.state}</span><span>{r.agentCount} agents</span><span>{r.goal}</span></button></li>)}</ul>{loaded && !rows.length && <p>No workstreams yet.</p>}</>}
    {detail && w && <>
      <p>{w.goal}</p><details><summary>Approved plan</summary><pre>{w.plan}</pre></details>
      <p aria-label="Budget use">{tokens.toLocaleString()} tokens{w.budget?.maxTokens != null && ` / ${w.budget.maxTokens.toLocaleString()}`} · {detail.roster.some((r) => r.costKnown === false) ? "Cost unpriced" : `$${cost.toFixed(4)} estimated`}{w.budget?.maxCostUsd != null && ` / $${w.budget.maxCostUsd}`}{w.budget?.maxWallMinutes != null && ` · ${Math.floor((Date.now() - w.createdAt) / 60000)} / ${w.budget.maxWallMinutes} minutes`}</p>
      <h2>Agents</h2><ul className="plain-list cards" aria-label="Agents">{detail.roster.map((r) => <li className="pad" key={r.agentId}>
        <h3>{r.name} <span className="badge">{r.status}</span></h3><p>{r.role}</p><p className="muted small">{r.model} · {r.branch ?? "Shared directory"} · {r.tokens.toLocaleString()} tokens · {r.costKnown === false ? "Cost unpriced" : `$${r.costUsd.toFixed(4)} estimated`}</p><p>{r.lastSummary}</p>
        <div className="row"><button onClick={() => void open(r)}>Open transcript</button><button disabled={archived || r.status === "archived"} onClick={() => { setText(""); setMessageTo(r); }}>Message</button><button disabled={archived || r.status === "archived"} onClick={() => void act("workstream_interrupt", { agentId: r.agentId })}>Interrupt</button><button disabled={r.status === "archived"} onClick={() => { setCleanup(false); setArchive(r); }}>Archive</button></div>
      </li>)}</ul>
      {!!detail.pendingPrompts.length && <section aria-label="Member prompts"><h2>Waiting for your answer</h2><Prompts prompts={detail.pendingPrompts.map((p) => ({ ...p, resolve() {} }))} onAnswer={(requestId, answer) => { const p = detail.pendingPrompts.find((p) => p.requestId === requestId)!; void act("workstream_answer_request", { agentId: p.agentId, requestId, answer }); }} /></section>}
      <h2>Messages</h2><ol aria-label="Message timeline">{detail.messages.map((m) => <li key={m.id}><strong>{detail.roster.find((r) => r.agentId === m.from)?.name ?? m.from} to {detail.roster.find((r) => r.agentId === m.to)?.name ?? m.to}</strong> <span className="muted small">{m.priority} · {m.readAt ? "Read" : m.deliveredAt ? "Delivered" : "Queued"}</span><p className="pre-wrap">{m.text}</p></li>)}</ol>
      <p className="muted">Before merging member branches, ask the lead to use the built-in overlap-check skill.</p>
    </>}
    {messageTo && <Dialog title={`Message ${messageTo.name}`} onClose={() => setMessageTo(undefined)}><form onSubmit={(e) => { e.preventDefault(); void act("workstream_send", { to: messageTo.agentId, message: text, priority }); setMessageTo(undefined); }}><textarea aria-label="Message" required value={text} onChange={(e) => setText(e.target.value)} /><label>Delivery<select aria-label="Delivery priority" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="now">Now: interrupt current turn</option><option value="next">Next: steer at the next boundary</option><option value="later">Later: queue until idle</option></select></label><button type="submit" className="primary">Send</button></form></Dialog>}
    {archive && <Dialog title={`Archive ${archive === "workstream" ? w?.title : archive.name}?`} onClose={() => setArchive(undefined)}><p>History is retained. Members stop running.</p><label className="check"><input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />Remove safe worktrees. Dirty work, local commits and open PRs are retained.</label><button className="danger" onClick={() => { const target = archive; setArchive(undefined); if (target === "workstream") void act("archive_workstream", { cleanupWorktrees: cleanup }); else void act("workstream_archive_agent", { agentId: target.agentId, cleanupWorktree: cleanup }); }}>Confirm archive</button></Dialog>}
    {budget && <Dialog title="Resume workstream" onClose={() => setBudget(false)}><p>Raise or clear a reached limit to resume. Blank means no limit.</p><form onSubmit={(e) => { e.preventDefault(); void act("resume_workstream", { budget: Object.fromEntries(["maxTokens", "maxCostUsd", "maxWallMinutes"].flatMap((key, i) => limits[i] === "" ? [] : [[key, Number(limits[i])]])) }); setBudget(false); }}>{["Token limit", "Estimated cost limit (USD)", "Wall time limit (minutes)"].map((label, i) => <label key={label}>{label}<input aria-label={label} type="number" min="0" step="any" value={limits[i]} onChange={(e) => setLimits((v) => v.map((n, j) => j === i ? e.target.value : n))} /></label>)}<button className="primary">Resume</button></form></Dialog>}
  </div>;
}

// The Agents tab: every agent of this session, with its full name, current step and running time.
import { useEffect, useRef, useState } from "react";
import { app } from "../lib/app-model.ts";
import { applyAgentEvent, memberRows, needsAgentReload, workerAgentRows, type AgentRow } from "../lib/agents.ts";
import { elapsed } from "../lib/missions.ts";
import type { SessionController } from "../lib/session.ts";

export function AgentsTab({ ctl, sessionId, active }: { ctl: SessionController; sessionId: string; active: boolean }) {
  const [rows, setRows] = useState<AgentRow[]>([]), [now, setNow] = useState(Date.now()), [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      const g = ++generation.current;
      let members: AgentRow[] = [], workers: AgentRow[] = [];
      try {
        const list = await app.request<{ workstreams: { id: string; leadSessionId: string; state: string }[] }>("list_workstreams");
        const w = list.workstreams.find((x) => x.leadSessionId === sessionId && x.state !== "archived");
        if (w) members = memberRows((await app.request("get_workstream", { id: w.id })).roster ?? []);
      } catch { /* no workstream data */ }
      try {
        const m = await ctl.request("mission_get");
        if (m?.exists) workers = workerAgentRows(m.features ?? [], m.progress?.currentWorker);
      } catch { /* this session has no mission data */ }
      if (dead || g !== generation.current) return;
      setRows([...members, ...workers]); setLoaded(true);
    };
    void load();
    const off = ctl.onAgentEvent((n) => { if (needsAgentReload(n.type)) void load(); else setRows((r) => applyAgentEvent(r, n)); });
    return () => { dead = true; off(); };
  }, [ctl, sessionId]);
  const ticking = active && rows.some((r) => r.active && r.startedAt);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return (
    <div className="agents-tab" aria-label="Agents in this session">
      {!rows.length && <p className="muted pad">{loaded ? "No agents in this session yet." : "Loading agents"}</p>}
      {rows.map((r) => (
        <article key={r.id} className="agent-row" aria-label={r.name}>
          <div className="agent-head"><strong className="agent-name">{r.name}</strong><span className={`live-state ${r.status === "Working" || r.status === "Starting" ? "working" : r.status === "Waiting for you" ? "waiting" : ""}`}>{r.status}</span></div>
          {(r.step || (r.active && r.startedAt)) && <div className="muted small">{r.step}{r.step && r.active && r.startedAt ? " · " : ""}{r.active && r.startedAt ? `Running ${elapsed(Math.max(0, now - r.startedAt))}` : ""}</div>}
          <details>
            <summary>Details</summary>
            <dl className="agent-details">
              {r.role && <><dt>Role</dt><dd>{r.role}</dd></>}
              {r.model && <><dt>Model</dt><dd>{r.model}</dd></>}
              {r.tokens !== undefined && <><dt>Tokens</dt><dd>{r.tokens.toLocaleString()}</dd></>}
              {r.costUsd !== undefined && <><dt>Cost</dt><dd>{r.costKnown === false ? "Not priced" : `$${r.costUsd.toFixed(2)}`}</dd></>}
              {r.branch && <><dt>Branch</dt><dd>{r.branch}</dd></>}
              {r.files?.length ? <><dt>Allowed files</dt><dd>{r.files.join(", ")}</dd></> : null}
              <dt>Session</dt><dd>{r.sessionId}</dd>
            </dl>
          </details>
        </article>
      ))}
    </div>
  );
}

// Mission Control (spec §15.8, §14.3): the list of missions with tabs, a New Mission dialog, and a detail view with features,
// workers, progress and pause. Missions are read with mission_list / mission_get; live changes come from the mission_*
// notifications and a short poll (a mission driven from another window reports through that window's connection).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { MISSION_TABS, applyNote, counts, elapsed, fromGet, inTab, pauseBanner, percentDone, stateLabel, tokenTotal, workerRows, type MissionDetail, type MissionListRow, type MissionTab } from "../lib/missions.ts";
import { DaemonConn } from "../lib/rpc.ts";
import { projectName } from "../lib/sessions.ts";
import { fmt } from "../lib/usage.ts";
import { Dialog } from "./Dialogs.tsx";

const POLL_MS = 2500;

export function Missions({ go }: { go(r: string): void }) {
  const a = useApp();
  const [tab, setTab] = useState<MissionTab>("All");
  const [rows, setRows] = useState<MissionListRow[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try { const r = await app.request("mission_list"); setRows(r.missions ?? []); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoaded(true); }
  }, []);
  useEffect(() => {
    if (a.daemon.state !== "running") return;
    void load();
    const t = setInterval(() => void load(), POLL_MS * 2);
    return () => clearInterval(t);
  }, [load, a.daemon.state]);

  const shown = rows.filter((r) => inTab(r.state, tab));
  const info = (id: string) => a.sessions.find((s) => s.id === id);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Mission Control</h1>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>New Mission</button>
      </header>
      <div className="seg tabs" role="tablist" aria-label="Mission states">
        {MISSION_TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}{t !== "All" ? ` (${rows.filter((r) => inTab(r.state, t)).length})` : ""}</button>)}
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      <ul className="plain-list cards" aria-label="Missions" data-testid="mission-list">
        {shown.map((m) => (
          <li key={m.sessionId}>
            <button className="card-row" onClick={() => go(`/missions/${m.sessionId}`)}>
              <span className={`badge state-${m.state}`}>{stateLabel(m.state)}</span>
              <span className="card-title">{m.title || info(m.sessionId)?.title || "Untitled mission"}</span>
              <span className="muted small">{projectName(info(m.sessionId)?.cwd)}</span>
            </button>
          </li>
        ))}
      </ul>
      {loaded && !shown.length && !error && <div className="empty-state">{rows.length ? `No ${tab.toLowerCase()} missions.` : "No missions yet. A mission is a long job that the agent plans with you and then works through feature by feature."}</div>}
      {creating && (
        <Dialog title="New Mission" onClose={() => setCreating(false)} wide>
          <ol className="steps">
            <li>Describe the goal. The orchestrator asks questions and writes a plan with you.</li>
            <li>Review and approve the plan.</li>
            <li>Workers build the features one at a time, with validation at each milestone.</li>
          </ol>
          <p className="muted"><strong>Orchestrator</strong> plans and decides. <strong>Workers</strong> each build one feature in their own session. <strong>Milestones</strong> group features and trigger validation.</p>
          <div className="banner warn small" role="note">Missions are not for simple tasks. They can run for hours or days and use far more tokens than a normal session.</div>
          <div className="dialog-actions">
            <button onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" onClick={() => { setCreating(false); go("/?mode=mission"); }}>Continue</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ detail

function useMission(sessionId: string, cwd: string | undefined, ready: boolean) {
  const [detail, setDetail] = useState<MissionDetail>();
  const [error, setError] = useState("");
  const conn = useRef<DaemonConn | undefined>(undefined);
  const exits = useRef<Record<string, number>>({});
  const [, bump] = useState(0);

  const pull = useCallback(async () => {
    const c = conn.current;
    if (!c || c.closed) return;
    try { setDetail(fromGet(await c.request("mission_get"))); setError(""); } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    if (!ready || !cwd) return;
    let dead = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const c = await DaemonConn.open();
        if (dead) { c.close(); return; }
        conn.current = c;
        c.onNotification = (m, p) => {
          if (m !== "session_notification") return;
          const n = p.notification ?? {};
          if (typeof n.type === "string" && n.type.startsWith("mission_")) { setDetail((d) => (d ? applyNote(d, n, exits.current) : d)); bump((x) => x + 1); }
        };
        await c.request("load_session", { sessionId, cwd });
        await pull();
        timer = setInterval(() => void pull(), POLL_MS);
      } catch (e) { setError((e as Error).message); }
    })();
    return () => { dead = true; if (timer) clearInterval(timer); conn.current?.close(); conn.current = undefined; };
  }, [sessionId, cwd, ready, pull]);

  return { detail, error, exits: exits.current, request: (m: string, p: Record<string, unknown> = {}) => conn.current!.request(m, p), pull };
}

export function MissionDetailPage({ sessionId, go }: { sessionId: string; go(r: string): void }) {
  const a = useApp();
  const row = a.sessions.find((s) => s.id === sessionId);
  const m = useMission(sessionId, row?.cwd, a.daemon.state === "running");
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const d = m.detail;
  const workers = useMemo(() => (d ? workerRows(d.features, m.exits) : []), [d, m.exits]);
  const act = async (fn: () => Promise<any>, ok: string) => { try { const r = await fn(); setMsg(r?.paused === false ? `Not paused: ${r.state ?? "nothing is running"}` : ok); } catch (e) { setMsg((e as Error).message); } void m.pull(); };

  if (!row) return <div className="center-note">{a.sessions.length ? "This mission's session was not found." : "Loading"}</div>;
  const c = counts(d?.features ?? []);
  const active = d && ["running", "initializing", "orchestrator_turn"].includes(d.state);
  const measured = d?.progress?.activeTime;
  const activeMs = measured ? measured.elapsedMs + (active ? Math.max(0, now - measured.measuredAtMs) : 0) : undefined;
  const banner = d?.state === "paused" ? pauseBanner(d.pauseReason) ?? "This mission is paused." : undefined;

  return (
    <div className="page">
      <header className="page-head">
        <button onClick={() => go("/missions")} aria-label="Back to Mission Control">Back</button>
        <h1>{row.title}</h1>
        {d && <span className={`badge state-${d.state}`} data-testid="mission-state">{stateLabel(d.state)}</span>}
        <span className="spacer" />
        <button onClick={() => go(`/sessions/${sessionId}`)}>Open orchestrator session</button>
        <button disabled={!active && d?.state !== "planning"} onClick={() => void act(() => m.request("mission_pause"), "Paused")}>Pause</button>
      </header>
      {m.error && <div className="banner error" role="alert">{m.error}</div>}
      {banner && <div className="banner warn" role="status">{banner}</div>}
      {msg && <div className="banner small" role="status">{msg}</div>}
      {d && !d.exists && <div className="empty-state">This session has not started a mission yet.</div>}
      {d?.exists && (
        <>
          <div className="stats" data-testid="mission-stats">
            <div><div className="stat-n">{percentDone(d.features)}%</div><div className="muted small">done</div></div>
            <div><div className="stat-n">{c.completed}/{c.total - c.cancelled}</div><div className="muted small">features</div></div>
            <div><div className="stat-n">{c.in_progress}</div><div className="muted small">in progress</div></div>
            <div><div className="stat-n">{activeMs != null ? elapsed(activeMs) : "-"}</div><div className="muted small">active time</div></div>
            <div><div className="stat-n">{fmt(tokenTotal(d.tokenUsage))}</div><div className="muted small">tokens (local)</div></div>
          </div>
          <h2>Features</h2>
          <table className="table" aria-label="Features">
            <thead><tr><th>Feature</th><th>Milestone</th><th>Status</th><th>Worker</th></tr></thead>
            <tbody>
              {d.features.map((f) => (
                <tr key={f.id}><td><div>{f.id}</div><div className="muted small">{f.description}</div></td><td>{f.milestone}</td><td><span className={`badge fs-${f.status}`}>{f.status.replace("_", " ")}</span></td><td className="mono small">{f.currentWorkerSessionId?.slice(0, 8) ?? ""}</td></tr>
              ))}
              {!d.features.length && <tr><td colSpan={4} className="muted">The plan has no features yet.</td></tr>}
            </tbody>
          </table>
          <h2>Workers</h2>
          <ul className="plain-list" aria-label="Workers">
            {workers.map((w) => (
              <li key={w.workerSessionId} className="srv">
                <span className={`dot ${w.active ? "running" : w.exitCode ? "failed" : "stopped"}`} />
                <span>{w.featureId}</span>
                <span className="muted small">{w.active ? "running" : w.exitCode == null ? "finished" : w.exitCode === 0 ? "finished" : `exit ${w.exitCode}`}</span>
                <span className="spacer" />
                {w.active && <button className="danger" aria-label={`Stop worker for ${w.featureId}`} onClick={() => void act(() => m.request("kill_worker_session", { workerSessionId: w.workerSessionId }), "Worker stopped")}>Stop worker</button>}
              </li>
            ))}
            {!workers.length && <li className="muted pad">No workers have started.</li>}
          </ul>
          <h2>Progress</h2>
          <ol className="log" aria-label="Progress log">
            {[...d.progressLog].reverse().slice(0, 40).map((e, i) => <li key={i}><span className="muted small">{String(e.timestamp ?? "").slice(11, 19)}</span> {String(e.type ?? "").replace(/_/g, " ")}{e.featureId ? ` (${e.featureId})` : ""}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}

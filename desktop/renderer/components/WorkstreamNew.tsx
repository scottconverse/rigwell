import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/app-model.ts";
import { draftFor, homeRoute, loadRole, ROLES, saveRole, TEMPLATES, type Role, type WsTemplate } from "../lib/workstream-templates.ts";
import { useAddFolder } from "./Home.tsx";

export function WorkstreamNew({ go }: { go(route: string): void }) {
  const a = useApp();
  const adder = useAddFolder((p) => { setFolder(p); setFolderOpen(false); });
  const [role, setRole] = useState<Role>(() => loadRole());
  const [roleOpen, setRoleOpen] = useState(false);
  const [picked, setPicked] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [template, setTemplate] = useState<WsTemplate | undefined>();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(a.recentFolders[0] ?? "");
  const [folderOpen, setFolderOpen] = useState(false);
  const [error, setError] = useState("");
  const roleWrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!roleOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRoleOpen(false); };
    const onClick = (e: MouseEvent) => { if (roleWrap.current && !roleWrap.current.contains(e.target as Node)) setRoleOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [roleOpen]);

  const start = (t: WsTemplate | undefined, n: string) => {
    setTemplate(t);
    setName(n);
    setPicked(true);
    setStep(1);
    setError("");
    setRoleOpen(false);
  };
  const reset = () => {
    setPicked(false);
    setTemplate(undefined);
    setName("");
    setStep(1);
    setError("");
    setFolderOpen(false);
  };
  const next = () => {
    if (!name.trim()) { setError("Give the workstream a name"); return; }
    setError("");
    setStep(2);
  };
  const create = () => {
    if (!folder) { setError("Choose a folder first."); return; }
    go(homeRoute(folder, draftFor(name, role, template)));
  };

  if (!picked) return (
    <section className="page ws-new">
      <h1>Start your workstream as{" "}
        <span className="chip-wrap" ref={roleWrap}>
          <button className="chip" aria-label="Your role" aria-haspopup="menu" onClick={() => setRoleOpen(!roleOpen)}>{role} ▾</button>
          {roleOpen && (
            <div className="menu" role="menu">
              {ROLES.map((r) => (
                <button key={r} className="menu-item" role="menuitem" onClick={() => { setRole(r); saveRole(r); setRoleOpen(false); }}>
                  {r === role ? `${r}   Your role ✓` : r}
                </button>
              ))}
            </div>
          )}
        </span>
      </h1>
      <div className="ws-templates">
        {TEMPLATES.map((t) => (
          <button key={t.name} className="ws-card" onClick={() => start(t, t.name)}>
            <div className="ws-art"><svg width="84" height="44" viewBox="0 0 84 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: t.art }} /></div>
            <div className="ws-card-body"><b>{t.name}</b><div className="ws-card-sum">{t.summary}</div></div>
          </button>
        ))}
      </div>
      <button className="ws-card ws-blank" onClick={() => start(undefined, "New workstream")}>
        <span className="ws-blank-plus">+</span>
        <span><b>Or begin with a blank workstream</b><div className="ws-card-sum">Begin empty and state the goal in the chat</div></span>
      </button>
      {adder.dialog}
    </section>
  );

  return (
    <section className="page ws-new">
      {step === 1 ? (
        <div className="ws-wizard">
          <div><b>Type:</b> {template?.name ?? "Custom"}</div>
          <h2>Name it</h2>
          <div className="card"><input aria-label="Workstream name" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} /></div>
          {error && <div className="ws-error">{error}</div>}
          <div className="ws-actions">
            <button onClick={reset}>Reset</button>
            <button className="primary" onClick={next}>Continue</button>
          </div>
        </div>
      ) : (
        <div className="ws-wizard">
          <div><b>Title:</b> {name}</div>
          <h2>Where should it run?</h2>
          <div className="card">
            <label className="ws-label">WHERE IT RUNS</label>
            <select aria-label="Where it runs" disabled><option>Local</option></select>
            <label className="ws-label">WORKING DIRECTORY</label>
            <span className="chip-wrap">
              <button className="chip" aria-label="Working directory" aria-haspopup="listbox" onClick={() => setFolderOpen(!folderOpen)}>{folder || "Choose a folder"}</button>
              {folderOpen && (
                <div className="menu" role="listbox">
                  {a.recentFolders.map((f) => <button key={f} role="option" aria-selected={f === folder} className="menu-item" onClick={() => { setFolder(f); setFolderOpen(false); setError(""); }}>{f}</button>)}
                  <button className="menu-item" role="option" onClick={() => void adder.pick()}>+ Add new project</button>
                </div>
              )}
            </span>
            <div className="hint">The orchestrator begins in this folder, and so do agents on this machine.</div>
          </div>
          {error && <div className="ws-error">{error}</div>}
          <div className="ws-actions">
            <button onClick={reset}>Reset</button>
            <button className="primary" onClick={create}>Create workstream</button>
          </div>
        </div>
      )}
      {adder.dialog}
    </section>
  );
}

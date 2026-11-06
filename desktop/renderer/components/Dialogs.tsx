// Small dialogs shared by several screens: folder trust (spec §5.6), rename, confirm, Connectors (§5.7) and Skills (§5.8).
import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge } from "../lib/rpc.ts";
import { app, useStore } from "../lib/app-model.ts";
import { trustAsks, type SessionController } from "../lib/session.ts";
import { mcpAuthButtons, pollLogin, type LoginStatus } from "../lib/access.ts";

export function Dialog({ title, onClose, children, wide }: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Asks whether the user trusts the files in a folder before it is added to the projects list (spec §5.6). */
export function TrustDialog({ folder, unlocks, cancelLabel, onTrust, onCancel }: { folder: string; unlocks?: string[]; cancelLabel?: string; onTrust(): void; onCancel(): void }) {
  return (
    <Dialog title="Trust this folder?" onClose={onCancel}>
      <p className="mono-line">{folder}</p>
      <p className="muted">A trusted folder lets the agent use the project settings, hooks, skills and tools that live inside it. Only trust folders whose contents you control.</p>
      {unlocks && unlocks.length > 0 && <ul className="muted" aria-label="Trust unlocks">{unlocks.map((u) => <li key={u}>{u}</li>)}</ul>}
      <div className="dialog-actions">
        <button onClick={onCancel}>{cancelLabel ?? "Cancel"}</button>
        <button className="primary" onClick={onTrust}>Trust folder</button>
      </div>
    </Dialog>
  );
}

export function TextDialog({ title, label, initial, action, onSubmit, onCancel }: { title: string; label: string; initial: string; action: string; onSubmit(v: string): void; onCancel(): void }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog title={title} onClose={onCancel}>
      <label className="field"><span>{label}</span>
        <input autoFocus value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) onSubmit(v.trim()); }} />
      </label>
      <div className="dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>{action}</button>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm, onCancel }: { title: string; body: string; action: string; onConfirm(): void; onCancel(): void }) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <p className="muted pre">{body}</p>
      <div className="dialog-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={onConfirm}>{action}</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Connectors

export interface McpServer { name: string; status: string; serverType: string; source?: string; displayName?: string; error?: string; toolCount?: number; requiresAuth?: boolean; hasAuthTokens?: boolean }

/** MCP server list, refresh, add and remove over any `request` function (a session, or a temporary connection). */
export function useMcp(request: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [summary, setSummary] = useState<{ total: number; connected: number; failed: number; configError?: { path: string; message: string } }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!request) return;
    try { const r = await request("list_mcp_servers"); setServers(r.servers ?? []); setSummary(r.summary); setError(""); } catch (e) { setError((e as Error).message); }
  }, [request]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); await refresh(); } };
  const [login, setLogin] = useState<{ name: string; status: LoginStatus } | null>(null);
  /** Browser sign-in (docs/auth.md): the daemon gives a URL, the system browser opens it, the page polls until done. */
  const signIn = (name: string) => run(async () => {
    const first: LoginStatus = await request!("mcp_auth_start", { serverName: name });
    setLogin({ name, status: first });
    try {
      if (first.url) void bridge().shell.openExternal(first.url).catch(() => {});
      const done = await pollLogin(() => request!("auth_login_status", { loginId: first.loginId }), { cancelled: () => mcpCancelled.has(first.loginId) });
      if (done.state === "failed") throw new Error(done.error ?? "Sign-in failed.");
    } finally { setLogin(null); }
  });
  return {
    servers, summary, error, busy, refresh, login,
    add: (p: Record<string, unknown>) => run(() => request!("add_mcp_server", p)),
    remove: (name: string) => run(() => request!("remove_mcp_server", { serverName: name, settingsLevel: "user" })),
    signIn,
    signOut: (name: string) => run(() => request!("mcp_auth_logout", { serverName: name })),
    stopWaiting: () => { if (login) mcpCancelled.add(login.status.loginId); },
  };
}
const mcpCancelled = new Set<string>();

/** Shown while an MCP sign-in waits for the browser. */
export function McpLoginPanel({ login, onCancel }: { login: { name: string; status: LoginStatus } | null; onCancel(): void }) {
  if (!login) return null;
  const u = login.status.url;
  return (
    <div className="banner" role="status" aria-label="Sign-in in progress" data-testid="mcp-login-panel">
      <div>Signing in to <b>{login.name}</b>...</div>
      <div className="small">A browser window should open. If it did not, <a href={u} data-testid="mcp-login-url" onClick={(e) => { e.preventDefault(); if (u) void bridge().shell.openExternal(u); }}>open the sign-in page</a>.</div>
      <button onClick={onCancel}>Stop waiting</button>
    </div>
  );
}

export function AddServerForm({ onAdd, busy }: { onAdd(p: Record<string, unknown>): Promise<void>; busy: boolean }) {
  const [type, setType] = useState<"stdio" | "http" | "sse">("stdio");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { setErr("The name can use letters, digits, - and _."); return; }
    if (!target.trim()) { setErr(type === "stdio" ? "Enter the command to run." : "Enter the server URL."); return; }
    setErr("");
    const p: Record<string, unknown> = { name, type };
    if (type === "stdio") { const [command, ...args] = target.trim().split(/\s+/); p.command = command; p.args = args; } else p.url = target.trim();
    await onAdd(p);
    setName(""); setTarget("");
  };
  return (
    <div className="addserver">
      <select value={type} onChange={(e) => setType(e.target.value as any)} aria-label="Server type"><option value="stdio">Command (stdio)</option><option value="http">HTTP</option><option value="sse">SSE</option></select>
      <input placeholder="Name" aria-label="Server name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder={type === "stdio" ? "Command and arguments" : "https://server/mcp"} aria-label={type === "stdio" ? "Command" : "URL"} value={target} onChange={(e) => setTarget(e.target.value)} />
      <button className="primary" disabled={busy} onClick={() => void submit()}>Add MCP Server</button>
      {err && <div className="error-text small" role="alert">{err}</div>}
    </div>
  );
}

export function ServerList({ servers, onRemove, onSignIn, onSignOut, busy }: { servers: McpServer[]; onRemove(n: string): void; onSignIn?(n: string): void; onSignOut?(n: string): void; busy: boolean }) {
  if (!servers.length) return <div className="muted pad">No MCP servers yet.</div>;
  return (
    <ul className="plain-list" aria-label="MCP servers">
      {servers.map((s) => (
        <li key={s.name} className="srv">
          <span className={`dot ${s.status === "connected" ? "running" : s.status === "failed" ? "failed" : "starting"}`} />
          <span className="srv-name">{s.displayName ?? s.name}</span>
          <span className="muted small">{s.serverType} / {s.status}{s.toolCount != null ? ` / ${s.toolCount} tools` : ""}{s.requiresAuth ? " / needs sign-in" : ""}</span>
          {s.error && <span className="error-text small">{s.error}</span>}
          <span className="spacer" />
          {onSignIn && mcpAuthButtons(s).signIn && <button className="primary" disabled={busy} aria-label={`Sign in to ${s.name}`} onClick={() => onSignIn(s.name)}>Sign in</button>}
          {onSignOut && mcpAuthButtons(s).signOut && <button disabled={busy} aria-label={`Sign out of ${s.name}`} onClick={() => onSignOut(s.name)}>Sign out</button>}
          {s.source === "user" || s.source === undefined ? <button disabled={busy} aria-label={`Remove ${s.name}`} onClick={() => onRemove(s.name)}>Remove</button> : <span className="muted small">{s.source}</span>}
        </li>
      ))}
    </ul>
  );
}

export function ConnectorsDialog({ ctl, onClose }: { ctl: SessionController; onClose(): void }) {
  const request = useMemo(() => ctl.request.bind(ctl), [ctl]);
  const m = useMcp(request);
  const [q, setQ] = useState("");
  const shown = useMemo(() => m.servers.filter((s) => `${s.name} ${s.displayName ?? ""}`.toLowerCase().includes(q.toLowerCase())), [m.servers, q]);
  return (
    <Dialog title="Connectors" onClose={onClose} wide>
      <div className="dlg-row">
        <input placeholder="Search" aria-label="Search connectors" value={q} onChange={(e) => setQ(e.target.value)} />
        <button onClick={() => void m.refresh()}>Refresh</button>
        <button onClick={() => void bridge().app.info().then((i) => bridge().shell.openPath(`${i.home}/mcp.json`))} title="Opens the MCP configuration file">Edit mcp.json</button>
      </div>
      <h4>MCP Servers ({m.servers.length})</h4>
      {m.summary?.configError && <div className="banner warn" role="status">{m.summary.configError.path}: {m.summary.configError.message}</div>}
      <ServerList servers={shown} busy={m.busy} onRemove={(n) => void m.remove(n)} onSignIn={(n) => void m.signIn(n)} onSignOut={(n) => void m.signOut(n)} />
      <McpLoginPanel login={m.login} onCancel={m.stopWaiting} />
      <AddServerForm busy={m.busy} onAdd={m.add} />
      {m.error && <div className="banner error" role="alert">{m.error}</div>}
      <div className="dialog-actions"><button onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Skills

interface SkillView { name: string; description: string; bucket: string; status: string; filePath: string; body: string; errors: string[]; userInvocable: boolean }
type SkillTab = "All" | "Personal" | "Built-in";
export const skillTab = (s: { bucket: string }): SkillTab => (s.bucket === "builtin" ? "Built-in" : "Personal");

/** Skills come from the shared registry in the main process (no daemon method lists them). `list_tools` only tells whether the Skill tool is exposed. */
export function SkillsDialog({ ctl, cwd, onClose }: { ctl?: SessionController; cwd: string; onClose(): void }) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [toolOn, setToolOn] = useState<boolean>();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<SkillTab>("All");
  const [sel, setSel] = useState<string>();
  useEffect(() => { void bridge().skills.list(cwd).then(setSkills).catch(() => setSkills([])); }, [cwd]);
  useEffect(() => { void ctl?.request("list_tools").then((r) => setToolOn((r.tools ?? []).some((t: any) => t.id === "Skill"))).catch(() => {}); }, [ctl]);
  const rows = skills.filter((s) => (tab === "All" || skillTab(s) === tab) && `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
  const cur = skills.find((s) => s.filePath === sel) ?? rows[0];
  return (
    <Dialog title="Skills" onClose={onClose} wide>
      <div className="dlg-row">
        <input placeholder="Search skills" aria-label="Search skills" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg" role="tablist">{(["All", "Personal", "Built-in"] as SkillTab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
      </div>
      {toolOn === false && <div className="banner warn small" role="status">The Skill tool is not available to the agent in this session, so skills are listed but cannot be loaded by the model.</div>}
      <div className="skills">
        <ul className="plain-list skill-list" aria-label="Skills">
          {rows.map((s) => (
            <li key={s.filePath}><button className={`side-row ${cur?.filePath === s.filePath ? "on" : ""}`} onClick={() => setSel(s.filePath)}>
              <span className="side-title">{s.name}</span><span className="muted small">{s.status === "enabled" ? skillTab(s) : s.status}</span>
            </button></li>
          ))}
          {!rows.length && <li className="muted pad">No skills found. Add a folder with a SKILL.md under ~/.rigwell/skills or .rigwell/skills.</li>}
        </ul>
        <div className="skill-preview">
          {cur ? (<><h4>{cur.name}</h4><p className="muted">{cur.description}</p>{cur.errors.length > 0 && <p className="error-text small">{cur.errors.join(" ")}</p>}<pre className="code-block">{cur.body}</pre><div className="muted small">{cur.filePath}</div></>) : <div className="muted pad">Select a skill to preview its SKILL.md.</div>}
        </div>
      </div>
      <div className="dialog-actions"><button onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

/** The harness asks (rigwell.request_trust) whether to trust the folder of a session being created or resumed. Escape and the backdrop mean no. */
export function TrustAsks() {
  const st = useStore(trustAsks);
  const a = st.asks[0];
  if (!a) return null;
  return <TrustDialog key={a.id} folder={a.cwd} unlocks={a.unlocks} cancelLabel="Don't trust"
    onCancel={() => trustAsks.answer(a.id, false)}
    onTrust={() => { trustAsks.answer(a.id, true); setTimeout(() => void app.refreshUserSettings(), 500); }} />;
}

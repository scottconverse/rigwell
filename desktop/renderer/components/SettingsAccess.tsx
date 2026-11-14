// Settings pages added in wave 4 (owner approved): API keys and secrets, environments, accounts (OAuth sign-in), voice
// dictation, plus the "[managed by org]" label. Secrets are write-only here: only masks come back from the daemon.
import { useCallback, useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { DEFAULT_ENV_ROW, defaultMode, deleteWarning, pollLogin, providerStatus, validateSecret, varsToParam, type EnvironmentRow, type EnvVarRow, type LoginStatus, type ProviderRow, type SecretRow } from "../lib/access.ts";
import { bridge } from "../lib/rpc.ts";
import { Dialog } from "./Dialogs.tsx";

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="row"><div className="row-label"><div>{label}</div>{hint && <div className="muted small">{hint}</div>}</div><div className="row-ctl">{children}</div></div>
);

// ------------------------------------------------------------------ org labels

export function useOrg() {
  const [org, setOrg] = useState<{ managed: boolean; keys: string[]; maxAutonomyLevel?: string }>({ managed: false, keys: [] });
  useEffect(() => { void bridge().org.managed().then(setOrg).catch(() => {}); }, []);
  return org;
}

/** "[managed by org]" next to a heading or row when the organization's settings file sets any of `keys`. */
export function ManagedNote({ keys }: { keys: string[] }) {
  const org = useOrg();
  const hit = keys.filter((k) => org.keys.includes(k));
  if (!hit.length) return null;
  return <span className="badge managed" data-testid="managed-by-org" title={`Set by your organization: ${hit.join(", ")}. A value you choose here is overridden.`}>[managed by org]</span>;
}

/** Autonomy ceiling line for the Session Defaults page. */
export function OrgCeiling() {
  const org = useOrg();
  if (!org.maxAutonomyLevel) return null;
  return <div className="banner small" role="status">Autonomy is capped at {org.maxAutonomyLevel} <span className="badge managed">[managed by org]</span></div>;
}

function useDaemonList<T>(method: string, pick: (r: any) => T[]) {
  const a = useApp();
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try { setItems(pick(await app.request(method))); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoaded(true); }
  }, [method]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (a.daemon.state === "running") void refresh(); }, [a.daemon.state, refresh]);
  return { items, error, loaded, refresh };
}

// ------------------------------------------------------------------ API keys and secrets

export function ApiKeys() {
  const { items, error, loaded, refresh } = useDaemonList<SecretRow>("list_secrets", (r) => r.secrets ?? []);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");
  const [replace, setReplace] = useState<SecretRow | null>(null);
  const [del, setDel] = useState<SecretRow | null>(null);

  const add = async () => {
    const bad = validateSecret(name, value, items.map((s) => s.name), false);
    if (bad) { setMsg(bad); return; }
    try { const r = await app.request("set_secret", { name, value }); setValue(""); setName(""); setMsg(`Saved ${r.name} (${r.mask})`); await refresh(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <h2>API keys and secrets</h2>
      <p className="muted small">Secrets are stored in your system keychain when one is available. Their values are never shown again: only a mask is listed. Use one as a model's API key with <code>keychain:secret:NAME</code>, or in an environment.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <table className="table" aria-label="Secrets">
        <thead><tr><th>Name</th><th>Value</th><th>Used by</th><th /></tr></thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.name} data-secret={s.name}>
              <td className="mono">{s.name}</td><td className="mono" data-testid="secret-mask">{s.mask}</td>
              <td className="small">{s.usedBy.length ? s.usedBy.join(", ") : "-"}</td>
              <td className="row-ctl"><button aria-label={`Replace ${s.name}`} onClick={() => setReplace(s)}>Replace</button><button className="danger" aria-label={`Delete ${s.name}`} onClick={() => setDel(s)}>Delete</button></td>
            </tr>
          ))}
          {loaded && !items.length && <tr><td colSpan={4} className="muted">No secrets yet.</td></tr>}
        </tbody>
      </table>
      <h3>Add a secret</h3>
      <div className="dlg-row">
        <input aria-label="Secret name" placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <input aria-label="Secret value" type="password" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <button className="primary" onClick={() => void add()}>Save</button>
      </div>
      {msg && <div className="banner small" role="status">{msg}</div>}
      {replace && <ReplaceDialog secret={replace} onClose={() => setReplace(null)} onDone={(m) => { setReplace(null); setMsg(m); void refresh(); }} />}
      {del && (
        <Dialog title={`Delete ${del.name}?`} onClose={() => setDel(null)}>
          <p className="muted">{deleteWarning(del)}</p>
          <div className="dialog-actions"><button onClick={() => setDel(null)}>Cancel</button>
            <button className="danger" onClick={() => void app.request("delete_secret", { name: del.name }).then(() => { setMsg(`Deleted ${del.name}`); setDel(null); void refresh(); }, (e) => { setMsg((e as Error).message); setDel(null); })}>Delete</button></div>
        </Dialog>
      )}
    </>
  );
}

function ReplaceDialog({ secret, onClose, onDone }: { secret: SecretRow; onClose(): void; onDone(msg: string): void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const save = async () => {
    if (!value) { setErr("Enter the new value."); return; }
    try { const r = await app.request("set_secret", { name: secret.name, value }); setValue(""); onDone(`Replaced ${r.name} (${r.mask})`); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Dialog title={`Replace ${secret.name}`} onClose={onClose}>
      <p className="muted small">The current value is {secret.mask}. It cannot be shown; entering a new value replaces it.</p>
      <label className="field"><span>New value</span><input type="password" aria-label="New value" autoFocus value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></label>
      {err && <div className="error-text" role="alert">{err}</div>}
      <div className="dialog-actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void save()}>Replace</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ environments

export function Environments() {
  const { items, error, loaded, refresh } = useDaemonList<EnvironmentRow>("list_environments", (r) => r.environments ?? []);
  const secrets = useDaemonList<SecretRow>("list_secrets", (r) => r.secrets ?? []);
  const [editing, setEditing] = useState<EnvironmentRow | "new" | null>(null);
  const [msg, setMsg] = useState("");
  return (
    <>
      <h2>Environments</h2>
      <p className="muted small">A named set of variables for the commands of a session. A variable is a literal value or a reference to a secret; values of secrets never reach the model or the transcript.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {msg && <div className="banner small" role="status">{msg}</div>}
      <div className="row-ctl"><button className="primary" onClick={() => setEditing("new")}>New environment</button></div>
      <table className="table" aria-label="Environments">
        <thead><tr><th>Name</th><th>Variables</th><th /></tr></thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.name} data-environment={e.name}>
              <td className="mono">{e.name}{e.description ? <div className="muted small">{e.description}</div> : null}</td>
              <td className="small">{e.vars.map((v) => v.kind === "secret" ? `${v.name} = secret ${v.secret}${v.missing ? " (missing)" : ""}` : `${v.name} = ${v.value}`).join(", ") || "-"}</td>
              <td className="row-ctl"><button aria-label={`Edit ${e.name}`} onClick={() => setEditing(e)}>Edit</button><button className="danger" aria-label={`Delete ${e.name}`} onClick={() => void app.request("delete_environment", { name: e.name }).then(() => { setMsg(`Deleted ${e.name}`); void refresh(); })}>Delete</button></td>
            </tr>
          ))}
          {loaded && !items.length && <tr><td colSpan={3} className="muted">No environments yet.</td></tr>}
        </tbody>
      </table>
      {editing && <EnvDialog env={editing === "new" ? null : editing} secrets={secrets.items.map((s) => s.name)} onClose={() => setEditing(null)} onSaved={(n) => { setEditing(null); setMsg(`Saved ${n}`); void refresh(); }} />}
    </>
  );
}

function EnvDialog({ env, secrets, onClose, onSaved }: { env: EnvironmentRow | null; secrets: string[]; onClose(): void; onSaved(name: string): void }) {
  const [name, setName] = useState(env?.name ?? "");
  const [description, setDescription] = useState(env?.description ?? "");
  const [rows, setRows] = useState<EnvVarRow[]>(env?.vars.map((v) => (v.kind === "secret" ? { name: v.name, kind: "secret" as const, secret: v.secret } : v)) ?? [{ ...DEFAULT_ENV_ROW }]);
  const [err, setErr] = useState("");
  const set = (i: number, p: Partial<EnvVarRow>) => setRows((r) => r.map((x, j) => (j === i ? ({ ...x, ...p } as EnvVarRow) : x)));
  const save = async () => {
    try {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("Give the environment a name (letters, digits, dots, dashes, underscores).");
      const vars = varsToParam(rows.filter((r) => r.name || (r.kind === "literal" ? r.value : r.secret)));
      await app.request("set_environment", { name, vars, ...(description.trim() ? { description: description.trim() } : {}) });
      onSaved(name);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Dialog title={env ? `Edit ${env.name}` : "New environment"} onClose={onClose} wide>
      <label className="field"><span>Name</span><input aria-label="Environment name" value={name} disabled={!!env} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Description</span><input aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <div className="field"><span>Variables</span>
        {rows.map((r, i) => (
          <div className="dlg-row" key={i}>
            <input aria-label={`Variable ${i + 1} name`} placeholder="NAME" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            <select aria-label={`Variable ${i + 1} kind`} value={r.kind} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? (e.target.value === "secret" ? { name: y.name, kind: "secret" as const, secret: secrets[0] ?? "" } : { name: y.name, kind: "literal" as const, value: "" }) : y)))}>
              <option value="literal">Value</option><option value="secret">Secret</option>
            </select>
            {r.kind === "literal"
              ? <input aria-label={`Variable ${i + 1} value`} placeholder="value (shown in the list)" value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
              : <select aria-label={`Variable ${i + 1} secret`} value={r.secret} onChange={(e) => set(i, { secret: e.target.value })}>{!secrets.includes(r.secret) && <option value={r.secret}>{r.secret || "Choose a secret"}</option>}{secrets.map((s) => <option key={s} value={s}>{s}</option>)}</select>}
            <button aria-label={`Remove variable ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button onClick={() => setRows((x) => [...x, { ...DEFAULT_ENV_ROW }])}>Add variable</button>
      </div>
      {err && <div className="error-text" role="alert">{err}</div>}
      <div className="dialog-actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void save()}>Save environment</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ accounts (OAuth sign-in)

export function Accounts({ request = (method: string, params?: Record<string, unknown>) => app.request(method, params), openExternal = (url: string) => bridge().shell.openExternal(url), setup = false, onSignedIn }: {
  request?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  openExternal?: (url: string) => Promise<unknown>;
  setup?: boolean;
  onSignedIn?: () => void;
} = {}) {
  const a = useApp();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [login, setLogin] = useState<{ name: string; status: LoginStatus } | null>(null);
  const refresh = useCallback(async () => {
    try { const r = await request("auth_list"); setProviders(r.providers ?? []); setProblems(r.problems ?? []); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoaded(true); }
  }, []);
  useEffect(() => { if (setup || a.daemon.state === "running") void refresh(); }, [a.daemon.state, refresh]);

  const start = async (p: ProviderRow, mode: "browser" | "device") => {
    setError("");
    try {
      const first: LoginStatus = await request("auth_login_start", { name: p.name, mode });
      setLogin({ name: p.name, status: first });
      if (first.url) void openExternal(first.url).catch(() => {});
      const done = await pollLogin(() => request("auth_login_status", { loginId: first.loginId }), { onUpdate: (s) => setLogin({ name: p.name, status: { ...first, ...s } }), cancelled: () => cancelledRef.has(first.loginId) });
      if (done.state === "failed") setError(done.error ?? "Sign-in failed.");
      setLogin(null);
      await refresh();
      if (done.state === "complete") onSignedIn?.();
    } catch (e) { setError((e as Error).message); setLogin(null); }
  };
  const logout = async (p: ProviderRow) => { try { await request("auth_logout", { name: p.name }); await refresh(); } catch (e) { setError((e as Error).message); } };

  return (
    <>
      <h2>{setup ? "Sign in with an account" : "Accounts"}</h2>
      <p className="muted small">Sign in through the registered OAuth providers described in settings.json (<code>oauthProviders</code>). Only Rigwell-registered clients or your own registered clients can be used. Available sign-in methods depend on the provider. Tokens stay in the daemon: this page never sees them.</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {problems.map((p) => <div className="banner warn small" key={p}>{p}</div>)}
      <table className="table" aria-label="Accounts">
        <thead><tr><th>Provider</th><th>Status</th><th /></tr></thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.name} data-provider={p.name}>
              <td className="mono">{p.name}{p.apiBaseUrl ? <div className="muted small">{p.apiBaseUrl}</div> : null}</td>
              <td className="small" data-testid="provider-status">{providerStatus(p)}</td>
              <td className="row-ctl">
                {p.browserLogin && <button className="primary" aria-label={`Sign in to ${p.name}`} disabled={!!login} onClick={() => void start(p, defaultMode(p))}>{p.loggedIn ? "Sign in again" : `Sign in with ${p.name}`}</button>}
                {p.deviceLogin && <button aria-label={`Sign in to ${p.name} with a code`} disabled={!!login} onClick={() => void start(p, "device")}>{p.browserLogin ? "Use a code" : p.loggedIn ? "Sign in again" : `Sign in with ${p.name}`}</button>}
                {p.loggedIn && <button aria-label={`Sign out of ${p.name}`} onClick={() => void logout(p)}>Sign out</button>}
              </td>
            </tr>
          ))}
          {loaded && !providers.length && <tr><td colSpan={3} className="muted">Account sign-in is not available: no registered provider client is configured. Add Rigwell's registered <code>oauthProviders</code> entries or use an API key or local server below (docs/auth.md).</td></tr>}
        </tbody>
      </table>
      {login && <LoginPanel openExternal={openExternal} login={login} onCancel={() => { cancelledRef.add(login.status.loginId); }} />}
    </>
  );
}
const cancelledRef = new Set<string>();

function LoginPanel({ login, onCancel, openExternal }: { openExternal(url: string): Promise<unknown>; login: { name: string; status: LoginStatus }; onCancel(): void }) {
  const s = login.status;
  return (
    <div className="banner" role="status" aria-label="Sign-in in progress" data-testid="login-panel">
      <div>Signing in to <b>{login.name}</b>...</div>
      {s.kind === "device"
        ? <div>Open <a href={s.verificationUriComplete ?? s.verificationUri} onClick={(e) => { e.preventDefault(); const u = s.verificationUriComplete ?? s.verificationUri; if (u) void openExternal(u); }}>{s.verificationUri}</a> and enter the code <b className="mono" data-testid="device-code">{s.userCode}</b></div>
        : <div className="small">A browser window should open. If it did not, <a href={s.url} data-testid="login-url" onClick={(e) => { e.preventDefault(); if (s.url) void openExternal(s.url); }}>open the sign-in page</a>.</div>}
      <button onClick={onCancel}>Stop waiting</button>
    </div>
  );
}

// ------------------------------------------------------------------ voice dictation

export function VoiceSettings() {
  const a = useApp();
  const s = a.settings;
  const [status, setStatus] = useState<{ ready: boolean; remote: boolean; detected: string[]; message: string } | null>(null);
  useEffect(() => { void bridge().dictation.status().then(setStatus); }, [s?.dictation]);
  if (!s) return null;
  const d = s.dictation;
  const set = (patch: Partial<typeof d>) => void app.updateSettings({ dictation: patch });
  return (
    <>
      <h2>Voice dictation</h2>
      <p className="muted small">The microphone button in the composer records while you speak, turns the recording into text and puts it in the message box. Recording happens in this window; by default nothing leaves your computer.</p>
      <Row label="Speech to text">
        <select aria-label="Dictation backend" value={d.backend} onChange={(e) => set({ backend: e.target.value as typeof d.backend })}>
          <option value="off">Off</option><option value="command">Local command (whisper.cpp or whisper)</option><option value="remote">Remote endpoint</option>
        </select>
      </Row>
      {d.backend === "command" && (
        <>
          <Row label="Command" hint="Program and arguments. {file} is the recording. Empty uses whisper-cli from your PATH."><input aria-label="Dictation command" placeholder="whisper-cli -m /path/ggml-base.en.bin -f {file} -nt" defaultValue={d.command} onBlur={(e) => set({ command: e.target.value })} /></Row>
          <Row label="Model" hint="Path of the whisper.cpp model file, or a model name for the whisper CLI"><input aria-label="Dictation model" defaultValue={d.model} onBlur={(e) => set({ model: e.target.value })} /></Row>
          <Row label="Language" hint="Optional, such as en"><input aria-label="Dictation language" defaultValue={d.language} onBlur={(e) => set({ language: e.target.value })} /></Row>
        </>
      )}
      {d.backend === "remote" && (
        <>
          <div className="banner warn small" role="note">With a remote endpoint your recordings are sent to that server.</div>
          <Row label="Endpoint" hint="An OpenAI-compatible .../audio/transcriptions URL"><input type="url" aria-label="Dictation endpoint" defaultValue={d.remoteEndpoint} onBlur={(e) => set({ remoteEndpoint: e.target.value.trim() })} /></Row>
          <Row label="API key variable" hint="Name of an environment variable that holds the key (the key itself is not stored here)"><input aria-label="Dictation key variable" defaultValue={d.remoteApiKeyEnv} onBlur={(e) => set({ remoteApiKeyEnv: e.target.value.trim() })} /></Row>
          <Row label="Model"><input aria-label="Dictation remote model" placeholder="whisper-1" defaultValue={d.model} onBlur={(e) => set({ model: e.target.value })} /></Row>
        </>
      )}
      {status && <div className={status.ready ? "banner small" : "banner warn small"} role="status" data-testid="dictation-status">{status.ready ? "Ready. " : ""}{status.message}{status.detected.length ? ` Found on this computer: ${status.detected.join(", ")}.` : ""}</div>}
    </>
  );
}

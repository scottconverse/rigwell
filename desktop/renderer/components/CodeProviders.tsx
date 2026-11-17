import { useCallback, useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import type { CodeConnection } from "../../../src/auth/code-providers.ts";
import type { LoginStatus } from "../../../src/auth/oauth.ts";

type Request = (method: string, params?: Record<string, unknown>) => Promise<any>;
export function CodeProviders({ request = defaultRequest }: { request?: Request } = {}) {
  const [rows, setRows] = useState<CodeConnection[]>([]), [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { const result = await request("code_provider_list"); setRows(result.connections); setError(""); }
    catch (e) { setError((e as Error).message); }
  }, [request]);
  // The default request function is stable below; injected transports serve headless acceptance.
  useEffect(() => { void refresh(); }, [refresh]);
  return <><h2>Code providers</h2>
    <p className="muted small">Connect GitHub or GitLab for pull requests, review, triggers and sharing. Tokens stay in the daemon's credential store. Git pushes also need working Git authentication on this machine.</p>
    {error && <div role="alert" className="banner error">{error}</div>}
    {rows.map((row) => <Provider key={row.provider} row={row} request={request} refresh={refresh} />)}
  </>;
}

const defaultRequest: Request = (method, params) => app.request(method, params);

function Provider({ row, request, refresh }: { row: CodeConnection; request: Request; refresh(): Promise<void> }) {
  const label = row.provider === "github" ? "GitHub" : "GitLab";
  const [token, setToken] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  useEffect(() => {
    if (!login || login.state !== "pending") return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await request("code_provider_login_status", { provider: row.provider, loginId: login.loginId });
        if (stopped) return;
        if (status.state === "pending") timer = setTimeout(() => void poll(), 1000);
        else { setLogin(null); if (status.error) setError(status.error); await refresh(); }
      } catch (e) { if (!stopped) { setError((e as Error).message); setLogin(null); } }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login, request, refresh, row.provider]);
  const run = async (action: () => Promise<void>) => {
    setError(""); setBusy(true);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section aria-label={label} className="card">
    <h3>{label}</h3>
    <div role="status">{row.connected ? `Connected as ${row.account} (${row.source === "oauth" ? "OAuth" : "token"})` : "Disconnected"}</div>
    {row.connected && <p>Scopes: {row.scopes === undefined ? "Not reported by the provider; check token permissions at the provider." : row.scopes.length ? row.scopes.join(", ") : "No OAuth scopes reported."}</p>}
    {(error || row.error) && <div role="alert" className="banner error">{error || row.error}</div>}
    <div className="dlg-row">
      <input type="password" aria-label={`${label} token`} value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} placeholder="Access token" disabled={busy || !!login} />
      <button disabled={busy || !!login || !token.trim()} onClick={() => void run(async () => { const value = token; setToken(""); await request("code_provider_connect", { provider: row.provider, token: value }); await refresh(); })}>{row.connected ? "Replace token" : "Connect token"}</button>
      <button disabled={busy || !!login || !row.deviceLogin} onClick={() => void run(async () => { setLogin(await request("code_provider_login_start", { provider: row.provider })); })}>Sign in with a code</button>
      {(row.connected || row.source) && <button disabled={busy || !!login} onClick={() => void run(async () => { await request("code_provider_disconnect", { provider: row.provider }); await refresh(); })}>Disconnect</button>}
    </div>
    {!row.deviceLogin && <p className="muted small">Device sign-in needs Rigwell's registered client ID in oauthProviders.{row.provider}. See docs/auth.md. You can connect with a token now.</p>}
    {login && <div role="status" aria-label={`${label} device sign-in`}>
      <p>Open <a href={login.verificationUriComplete ?? login.verificationUri} onClick={(e) => { e.preventDefault(); const url = login.verificationUriComplete ?? login.verificationUri; if (url) void bridge().shell.openExternal(url); }}>{login.verificationUri}</a> and enter <b>{login.userCode}</b>.</p>
      <button disabled={busy} onClick={() => void run(async () => { await request("code_provider_login_cancel", { provider: row.provider, loginId: login.loginId }); setLogin(null); await refresh(); })}>Cancel sign-in</button>
    </div>}
  </section>;
}

import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import type { SharedSession } from "../../../src/sharing/format.ts";

export function SharedSessions({ id, go }: { id?: string; go(route: string): void }) {
  const [source, setSource] = useState(""), [cwd, setCwd] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [session, setSession] = useState<SharedSession>();
  useEffect(() => {
    let active = true; setSession(undefined); setError("");
    if (id) void app.request("get_shared_session", { importId: id }).then((r) => { if (active) setSession(r.session); }, (e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);
  const run = async (action: () => Promise<void>) => { setError(""); setBusy(true); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="page"><h1>{id ? "Imported session" : "Import a shared session"}</h1>
    <p>Imports are read-only. They cannot run tools or continue the original session. Fork into a chosen working folder to start a new session.</p>
    {error && <div role="alert" className="banner error">{error}</div>}
    {!id && <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const result = await app.request("import_shared_session", { source }); go(`/imports/${result.importId}`); }); }}>
      <label>Shared file or URL<input required aria-label="Shared file or URL" value={source} onChange={(e) => setSource(e.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void run(async () => { const file = await bridge().dialog.pickFile([{ name: "Session exports", extensions: ["html", "md", "json"] }]); if (file) setSource(file); })}>Choose shared file</button>
      <button disabled={busy || !source} type="submit">Import read-only</button>
    </form>}
    {id && session && <><h2>{session.title}</h2><p className="badge">Read-only</p>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const result = await app.request("fork_shared_session", { importId: id, cwd }); await app.refresh(); go(`/sessions/${result.sessionId}`); }); }}>
        <label>Working folder for fork<input required aria-label="Working folder for fork" value={cwd} onChange={(e) => setCwd(e.target.value)} /></label>
        <button disabled={busy} type="button" onClick={() => void run(async () => { const folder = await bridge().dialog.pickFolder(); if (folder) setCwd(folder); })}>Choose working folder</button>
        <button disabled={busy || !cwd} type="submit">Fork into new session</button>
      </form>
      {session.messages.map((m, i) => <article key={i} aria-label={`Imported ${m.role} message`}><h3>{m.role}</h3><pre className="pre">{m.text}</pre></article>)}
    </>}
  </div>;
}

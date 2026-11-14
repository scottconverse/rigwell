import { useCallback, useEffect, useRef, useState } from "react";
import { app } from "../lib/app-model.ts";
import { DaemonConn } from "../lib/rpc.ts";
import type { Prompt } from "../lib/session.ts";
import { Dialog } from "./Dialogs.tsx";
import { Prompts } from "./Prompts.tsx";

export function WorktreePr({ worktreePath, branch }: { worktreePath: string; branch?: string }) {
  const [status, setStatus] = useState<any>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(branch ?? "");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>();
  const pending = useRef<Prompt | undefined>(undefined);
  const conn = useRef<DaemonConn | undefined>(undefined);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try { const s = await app.request("get_pr_status", { worktreePath }); if (alive.current) { setStatus(s); setError(""); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }, [worktreePath]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; pending.current?.resolve({ selectedOption: "cancel" }); conn.current?.close(); };
  }, [reload]);
  const answer = (_id: string, result: unknown) => {
    pending.current?.resolve(result); pending.current = undefined; setPrompt(undefined);
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const c = await DaemonConn.open(); conn.current = c;
      if (!alive.current) { c.close(); return; }
      c.onRequest = async (method, params) => {
        if (method !== "request_permission" || params.toolUses?.[0]?.confirmationType !== "create_pr") return { selectedOption: "cancel" };
        return new Promise((resolve) => {
          const p: Prompt = { requestId: crypto.randomUUID(), method: "request_permission", params, resolve };
          pending.current = p; setPrompt(p);
        });
      };
      await c.request("create_pr", { worktreePath, title, body, ...(base.trim() ? { base: base.trim() } : {}), draft });
      if (alive.current) { setEditing(false); await reload(); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { pending.current = undefined; conn.current?.close(); conn.current = undefined; if (alive.current) { setBusy(false); setPrompt(undefined); } }
  };
  return <>
    {status?.state && status.state !== "none" && <span className="chip" aria-label={`PR ${status.state}`}>#{status.number} {status.state}{status.checks?.length ? `: ${status.checks.map((c: any) => `${c.name} ${c.state}`).join(", ")}` : ""}</span>}
    {status?.url && <a href={status.url} target="_blank" rel="noreferrer">View PR</a>}
    <button aria-label={`Refresh PR status ${worktreePath}`} onClick={() => void reload()}>Refresh PR</button>
    <button disabled={busy || status?.state === "open"} aria-label={`Create PR ${worktreePath}`} onClick={() => setEditing(true)}>Create PR</button>
    {error && !editing && <span role="alert" className="error-text small">{error}</span>}
    {editing && <Dialog title="Create PR" onClose={() => { if (!busy) setEditing(false); }}>
      <p>Branch: {branch}</p>
      {error && <div role="alert" className="error-text">{error}</div>}
      <label className="field"><span>Title</span><input aria-label="PR title" disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Body</span><textarea aria-label="PR body" disabled={busy} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field"><span>Base (empty uses the remote default)</span><input aria-label="PR base" disabled={busy} value={base} onChange={(e) => setBase(e.target.value)} /></label>
      <label><input type="checkbox" aria-label="Draft PR" disabled={busy} checked={draft} onChange={(e) => setDraft(e.target.checked)} />Draft</label>
      <Prompts prompts={prompt ? [prompt] : []} onAnswer={answer} />
      <div className="dialog-actions"><button disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button disabled={busy} onClick={() => void create()}>Review push and PR</button></div>
    </Dialog>}
  </>;
}

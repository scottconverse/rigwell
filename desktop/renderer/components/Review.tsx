import { useEffect, useRef, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { DaemonConn, bridge } from "../lib/rpc.ts";
import { SessionController, type Prompt } from "../lib/session.ts";
import { live } from "./SessionScreen.tsx";
import { Prompts } from "./Prompts.tsx";
import { highlight, languageOf } from "../lib/highlight.ts";
import { highlightCode } from "../lib/enhance.ts";
import type { DiffLine, ReviewComment, ReviewFile, ReviewSnapshot } from "../../../src/review/local.ts";

function FileTree({ files, current, pick }: { files: ReviewFile[]; current?: string; pick(path: string): void }) {
  const branch = (prefix: string): React.ReactNode => {
    const children = new Map<string, boolean>();
    for (const file of files.filter((f) => f.path.startsWith(prefix))) { const part = file.path.slice(prefix.length).split("/"); children.set(part[0], part.length > 1); }
    return [...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, directory]) => <li key={name} role="treeitem" aria-expanded={directory ? true : undefined} aria-selected={!directory && prefix + name === current}>
      {directory ? <><span>{name}/</span><ul role="group">{branch(prefix + name + "/")}</ul></> : <button onClick={() => pick(prefix + name)}>{name} <span className="muted">{files.find((f) => f.path === prefix + name)?.status}</span></button>}
    </li>);
  };
  return <ul className="review-tree" role="tree" aria-label="Changed files">{branch("")}</ul>;
}

function aligned(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine; hunk?: string }[] {
  const rows: { left?: DiffLine; right?: DiffLine; hunk?: string }[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.kind === "hunk") { rows.push({ hunk: line.text }); i++; }
    else if (line.kind === "context") { rows.push({ left: line, right: line }); i++; }
    else {
      const removed: DiffLine[] = [], added: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "removed") removed.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "added") added.push(lines[i++]);
      for (let n = 0; n < Math.max(removed.length, added.length); n++) rows.push({ left: removed[n], right: added[n] });
    }
  }
  return rows;
}

function FileDiff({ file, sideBySide, full, comment }: { file: ReviewFile; sideBySide: boolean; full: boolean; comment(side: "old" | "new", line: number): void }) {
  const [rich, setRich] = useState<{ old: string[]; new: string[] }>({ old: [], new: [] });
  useEffect(() => {
    let dead = false; setRich({ old: [], new: [] });
    const color = async (source: string) => {
      if (source.length > 300000) return [];
      const html = await highlightCode(source, languageOf(file.path));
      if (!html) return [];
      return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("code > .line")].map((line) => line.innerHTML);
    };
    void Promise.all([color(file.before), color(file.after)]).then(([old, next]) => { if (!dead) setRich({ old, new: next }); });
    return () => { dead = true; };
  }, [file]);
  if (file.binary) return <p>Binary file. Text and line comments are unavailable.</p>;
  const before = file.before.split("\n"), after = file.after.split("\n");
  const cell = (line: DiffLine | undefined, side: "old" | "new") => {
    const number = side === "old" ? line?.oldLine : line?.newLine;
    return <><td className="review-line">{number !== undefined && <button aria-label={`Comment on ${side} line ${number}`} onClick={() => comment(side, number)}>{number}</button>}</td><td className={`review-code shiki ${line?.kind ?? "empty"}`}><code dangerouslySetInnerHTML={{ __html: line ? (number === undefined ? undefined : rich[side][number - 1]) ?? highlight(line.text, file.path) : "" }} /></td></>;
  };
  if (sideBySide) {
    const rows = full ? Array.from({ length: Math.max(before.length, after.length) }, (_, n) => ({ left: n < before.length ? { kind: "context" as const, text: before[n], oldLine: n + 1 } : undefined, right: n < after.length ? { kind: "context" as const, text: after[n], newLine: n + 1 } : undefined, hunk: undefined })) : aligned(file.lines);
    return <table className="review-diff side-by-side" aria-label="Side-by-side diff"><thead><tr><th colSpan={2}>Before</th><th colSpan={2}>After</th></tr></thead><tbody>{rows.map((row, i) => row.hunk ? <tr key={i}><td className="review-hunk" colSpan={4}>{row.hunk}</td></tr> : <tr key={i}>{cell(row.left, "old")}{cell(row.right, "new")}</tr>)}</tbody></table>;
  }
  const lines: DiffLine[] = full ? [{ kind: "hunk", text: "Before (full file)" }, ...before.map((text, i) => ({ kind: "context" as const, text, oldLine: i + 1 })), { kind: "hunk", text: "After (full file)" }, ...after.map((text, i) => ({ kind: "context" as const, text, newLine: i + 1 }))] : file.lines;
  return <table className="review-diff" aria-label="Inline diff"><tbody>{lines.map((line, i) => line.kind === "hunk" ? <tr key={i}><td colSpan={3} className="review-hunk">{line.text}</td></tr> : <tr key={i}><td>{line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " "}</td>{cell(line, line.kind === "removed" || (line.oldLine !== undefined && line.newLine === undefined) ? "old" : "new")}</tr>)}</tbody></table>;
}

export function Review({ initialFolder = "", go }: { initialFolder?: string; go(route: string): void }) {
  const a = useApp(), [cwd, setCwd] = useState(initialFolder), [base, setBase] = useState(""), [mode, setMode] = useState("branch"), [number, setNumber] = useState("");
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>(), [path, setPath] = useState(""), [view, setView] = useState("inline"), [full, setFull] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]), [editing, setEditing] = useState<{ side: "old" | "new"; line: number }>(), [text, setText] = useState(""), [summary, setSummary] = useState("");
  const [error, setError] = useState(""), [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false), [prompt, setPrompt] = useState<Prompt>();
  const conn = useRef<DaemonConn | undefined>(undefined), pending = useRef<Prompt | undefined>(undefined), alive = useRef(true);
  useEffect(() => {
    let dead = false; alive.current = true;
    if (a.daemon.state === "running") void DaemonConn.open().then((c) => {
      if (dead) { c.close(); return; } conn.current = c; setConnected(true);
      c.onRequest = async (method, params) => {
        if (method !== "request_permission" || params.toolUses?.[0]?.confirmationType !== "code_review") return { selectedOption: "cancel" };
        return new Promise((resolve) => { const p: Prompt = { requestId: crypto.randomUUID(), method: "request_permission", params, resolve }; pending.current = p; setPrompt(p); });
      };
      c.onClose = () => { if (!dead) { setConnected(false); setError("Review connection closed. Reopen the page to reconnect."); } };
    }).catch((e) => { if (!dead) setError(e.message); });
    return () => { dead = true; alive.current = false; pending.current?.resolve({ selectedOption: "cancel" }); conn.current?.close(); conn.current = undefined; };
  }, [a.daemon.state]);
  const run = async (action: (c: DaemonConn) => Promise<void>) => {
    const c = conn.current; if (!c) return; setBusy(true); setError(""); setStatus("");
    try { await action(c); } catch (e) { if (alive.current && conn.current === c) setError((e as Error).message); }
    finally { if (alive.current && conn.current === c) { setBusy(false); setPrompt(undefined); pending.current = undefined; } }
  };
  const load = () => run(async (c) => {
    const result = await c.request<ReviewSnapshot>("review_snapshot", { cwd, ...(mode === "pr" ? { pr: number ? Number(number) : true } : base.trim() ? { base: base.trim() } : {}) });
    if (!alive.current || conn.current !== c) return;
    setSnapshot(result); setPath(result.files[0]?.path ?? ""); setComments([]); setEditing(undefined); setSummary("");
  });
  const post = (event: string) => run(async (c) => {
    const result = await c.request("review_submit", { snapshotId: snapshot!.id, event, body: summary, comments });
    if (alive.current) { setStatus(`Review posted: ${result.url}`); setComments([]); setSummary(""); setSnapshot(undefined); }
  });
  const address = () => run(async (c) => {
    const prepared = await c.request("review_task", { snapshotId: snapshot!.id, comments });
    const ctl = await SessionController.create({ cwd: prepared.cwd, title: "Address review comments" });
    const id = ctl.getSnapshot().sessionId!; live.set(id, ctl); await ctl.send(prepared.task); void app.refresh(); go(`/sessions/${id}`);
  });
  const file = snapshot?.files.find((f) => f.path === path);
  return <div className="page review-page"><h1>Review</h1>
    <div className="dlg-row"><label>Folder <input aria-label="Review folder" value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={busy} /></label><button disabled={busy} onClick={() => void bridge().dialog.pickFolder().then((folder) => { if (folder) setCwd(folder); })}>Choose folder</button>
      <select aria-label="Review source" disabled={busy} value={mode} onChange={(e) => setMode(e.target.value)}><option value="branch">Worktree branch</option><option value="pr">Pull request</option></select>
      {mode === "branch" ? <input aria-label="Review base" placeholder="Default branch" value={base} disabled={busy} onChange={(e) => setBase(e.target.value)} /> : <input aria-label="PR number" placeholder="Open PR for this branch" type="number" min={1} value={number} disabled={busy} onChange={(e) => setNumber(e.target.value)} />}
      <button disabled={!connected || busy || !cwd} onClick={() => void load()}>Load review</button></div>
    {error && <div role="alert" className="banner error">{error}</div>}{status && <div role="status" className="banner">{status}</div>}
    {snapshot && <><p>{snapshot.pr ? `#${snapshot.pr.number} ${snapshot.pr.title} [${snapshot.pr.state}]` : "Worktree branch and working changes"} | {snapshot.files.length} files | {snapshot.base.slice(0, 10)} to {snapshot.head.slice(0, 10)}</p>
      <label>View <select aria-label="Diff view" value={view} onChange={(e) => setView(e.target.value)}><option value="inline">Inline</option><option value="side">Side by side</option><option value="semantic">Semantic</option></select></label> <label><input type="checkbox" aria-label="Show full files" checked={full} onChange={(e) => setFull(e.target.checked)} />Show full files to comment on any line</label>
      <div className="review-layout"><aside><FileTree files={snapshot.files} current={path} pick={(next) => { setPath(next); setEditing(undefined); }} /></aside><section className="review-content">
        {view === "semantic" ? <section aria-label="Semantic changes"><h2>Changes by symbol</h2>{!snapshot.semantic.changes.length && <p>No function or class changes detected.</p>}{snapshot.semantic.changes.map((change, i) => <article key={i}><h3>{change.kind}{change.renamed ? "/renamed" : ""} {change.symbolKind} {change.name}{change.changed ? " (also changed)" : ""}</h3><p>{change.from ? `${change.from.path}:${change.from.line}-${change.from.endLine}` : "New symbol"} to {change.to ? `${change.to.path}:${change.to.line}-${change.to.endLine}` : "Removed"}</p><button onClick={() => { setPath(change.to?.path ?? change.from!.path); setView("side"); }}>View diff</button></article>)}{snapshot.semantic.warnings.map((w) => <p key={w.path} className="muted">{w.path}: {w.message}</p>)}</section>
          : file ? <><h2>{file.oldPath ? `${file.oldPath} to ` : ""}{file.path}</h2>{file.warning && <p className="banner warn">{file.warning}</p>}<FileDiff file={file} sideBySide={view === "side"} full={full} comment={(side, line) => { setEditing({ side, line }); setText(""); }} /></> : <p>No changed files.</p>}
      </section></div>
      {editing && <section aria-label="Line comment"><h3>{path}:{editing.line} ({editing.side})</h3><textarea aria-label="Comment body" value={text} onChange={(e) => setText(e.target.value)} /><button disabled={!text.trim() || busy} onClick={() => { setComments([...comments, { path, ...editing, body: text.trim() }]); setEditing(undefined); }}>Add comment</button><button onClick={() => setEditing(undefined)}>Cancel comment</button></section>}
      <section aria-label="Draft review comments"><h2>Draft comments ({comments.length})</h2>{comments.map((c, i) => <article key={i}><b>{c.path}:{c.line} ({c.side})</b><p>{c.body}</p><button disabled={busy} aria-label={`Remove comment ${i + 1}`} onClick={() => setComments(comments.filter((_, n) => n !== i))}>Remove</button></article>)}<button disabled={busy || !comments.length} onClick={() => void address()}>Send comments to agent</button></section>
      {snapshot.pr && <section aria-label="PR review"><h2>PR review</h2><h3>Checks</h3>{snapshot.checks.length ? <ul>{snapshot.checks.map((c, i) => <li key={i}>{c.name}: {c.state}</li>)}</ul> : <p>No checks reported.</p>}<h3>Existing comments</h3>{snapshot.comments.map((c, i) => <article key={i}><b>{c.author ?? "Reviewer"} {c.path ? `${c.path}:${c.line ?? ""}` : ""}</b><p>{c.body}</p></article>)}<label>Review summary<textarea aria-label="Review summary" value={summary} disabled={busy} onChange={(e) => setSummary(e.target.value)} /></label><div className="dlg-row"><button disabled={busy || (!comments.length && !summary.trim())} onClick={() => void post("COMMENT")}>Post comments</button><button disabled={busy} onClick={() => void post("APPROVE")}>Approve</button><button disabled={busy} onClick={() => void post("REQUEST_CHANGES")}>Request changes</button></div></section>}
    </>}
    <Prompts prompts={prompt ? [prompt] : []} onAnswer={(_id, result) => { pending.current?.resolve(result); pending.current = undefined; setPrompt(undefined); }} />
  </div>;
}

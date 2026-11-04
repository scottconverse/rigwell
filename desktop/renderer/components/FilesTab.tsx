// Files tab (spec §17.1): tree with search, viewer (code, markdown, images), editing with a stale-write guard.
import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge, RpcFailure } from "../lib/rpc.ts";
import { highlight, languageOf } from "../lib/highlight.ts";
import { highlightCode } from "../lib/enhance.ts";
import type { SessionController } from "../lib/session.ts";
import { Markdown } from "./Transcript.tsx";

interface FileData { filePath: string; content?: string; isBinary: boolean; mimeType: string; fingerprint: string; byteLength: number; encoding?: string }

const EDITORS: { id: string; label: string; url: (abs: string) => string }[] = [
  { id: "vscode", label: "VS Code", url: (p) => `vscode://file${p}` },
  { id: "cursor", label: "Cursor", url: (p) => `cursor://file${p}` },
  { id: "zed", label: "Zed", url: (p) => `zed://file${p}` },
];

function Tree({ files, dirs, open, toggle, pick, current }: { files: string[]; dirs: string[]; open: Set<string>; toggle(d: string): void; pick(f: string): void; current?: string }) {
  const rows = useMemo(() => {
    const all = [...dirs.map((d) => ({ path: d, dir: true })), ...files.map((f) => ({ path: f, dir: false }))];
    all.sort((a, b) => a.path.split("/").map((s, i, arr) => (i === arr.length - 1 && !a.dir ? "1" : "0") + s).join("/").localeCompare(b.path.split("/").map((s, i, arr) => (i === arr.length - 1 && !b.dir ? "1" : "0") + s).join("/")));
    return all.filter((r) => { const parts = r.path.split("/"); for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join("/"))) return false; return true; });
  }, [files, dirs, open]);
  return (
    <ul className="tree" role="tree">
      {rows.map((r) => {
        const depth = r.path.split("/").length - 1, name = r.path.split("/").pop()!;
        return (
          <li key={r.path} role="treeitem" aria-expanded={r.dir ? open.has(r.path) : undefined} aria-selected={r.path === current}>
            <button className={`tree-row ${r.path === current ? "sel" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => (r.dir ? toggle(r.path) : pick(r.path))}>
              <span className="tree-twist">{r.dir ? (open.has(r.path) ? "v" : ">") : ""}</span>{name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** File contents: the small built-in highlighter paints first, then shiki replaces it when it has the language. */
function CodeView({ code, path }: { code: string; path: string }) {
  const [rich, setRich] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setRich(null);
    if (code.length < 300_000) void highlightCode(code, languageOf(path)).then((h) => { if (!stale) setRich(h); });
    return () => { stale = true; };
  }, [code, path]);
  const plain = useMemo(() => highlight(code, path), [code, path]);
  return rich ? <div className="code shiki-wrap" data-testid="shiki-code" dangerouslySetInnerHTML={{ __html: rich }} /> : <pre className="code" dangerouslySetInnerHTML={{ __html: plain }} />;
}

export function FilesTab({ ctl, autoOpen, requestOpen, refreshKey }: { ctl: SessionController; autoOpen: boolean; requestOpen?: string; refreshKey: number }) {
  const cwd = ctl.getSnapshot().cwd;
  const [files, setFiles] = useState<string[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[] | null>(null);
  const [file, setFile] = useState<FileData | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [msg, setMsg] = useState("");
  const [editor, setEditor] = useState(EDITORS[0].id);
  const [markdownView, setMarkdownView] = useState(true);

  const load = useCallback(async () => {
    try { const r = await ctl.request("daemon.list_files", { showHidden: hidden }); setFiles(r.files); setDirs(r.directories ?? []); } catch (e) { setMsg((e as Error).message); }
  }, [ctl, hidden]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    const t = setTimeout(() => { void ctl.request("daemon.search_files", { query, maxResults: 60, showHidden: hidden }).then((r) => setHits(r.files), () => setHits([])); }, 120);
    return () => clearTimeout(t);
  }, [query, hidden, ctl]);

  const openFile = useCallback(async (path: string) => {
    setConflict(false); setDraft(null); setMsg("");
    try { setFile(await ctl.request<FileData>("daemon.get_workspace_file_content", { filePath: path, ...(/\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? { encoding: "base64" } : {}) })); } catch (e) { setMsg((e as Error).message); }
  }, [ctl]);
  useEffect(() => { if (requestOpen) void openFile(requestOpen); }, [requestOpen, openFile]);
  useEffect(() => { if (autoOpen && !file && files.length) { const readme = files.find((f) => /^readme(\.md)?$/i.test(f)); if (readme) void openFile(readme); } }, [autoOpen, files, file, openFile]);

  const save = async () => {
    if (!file || draft === null) return;
    try {
      const r = await ctl.request("daemon.write_workspace_file_content", { filePath: file.filePath, content: draft, baseFingerprint: file.fingerprint });
      setFile({ ...file, content: draft, fingerprint: r.fingerprint, byteLength: r.byteLength });
      setDraft(null); setConflict(false); setMsg("Saved");
    } catch (e) {
      if (e instanceof RpcFailure && e.code === -32006) setConflict(true); else setMsg((e as Error).message);
    }
  };

  const abs = file ? `${cwd.replace(/\/$/, "")}/${file.filePath}` : "";
  const isImage = file?.mimeType.startsWith("image/") && file.encoding === "base64";
  const isMd = file?.mimeType === "text/markdown";
  const toggle = (d: string) => setOpen((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  return (
    <div className="files">
      <div className="files-side">
        <div className="files-bar">
          <input placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files" />
          <button title="Show hidden files" aria-pressed={hidden} className={hidden ? "on" : ""} onClick={() => setHidden(!hidden)}>.*</button>
          <button title="Refresh" onClick={() => void load()}>Refresh</button>
        </div>
        {hits ? (
          <ul className="tree">{hits.map((h) => <li key={h}><button className="tree-row" onClick={() => void openFile(h)}>{h}</button></li>)}{!hits.length && <li className="muted pad">No matches</li>}</ul>
        ) : <Tree files={files} dirs={dirs} open={open} toggle={toggle} pick={(f) => void openFile(f)} current={file?.filePath} />}
      </div>
      <div className="files-view">
        {!file && <div className="empty">{msg || "Pick a file to view it"}</div>}
        {file && (
          <>
            <div className="file-head">
              <span className="file-name" title={abs}>{file.filePath}</span>
              <span className="spacer" />
              {isMd && draft === null && <button onClick={() => setMarkdownView(!markdownView)}>{markdownView ? "Source" : "Rendered"}</button>}
              {!file.isBinary && !isImage && draft === null && <button onClick={() => setDraft(file.content ?? "")}>Edit</button>}
              {draft !== null && (<><button className="primary" onClick={() => void save()}>Save</button><button onClick={() => { setDraft(null); setConflict(false); }}>Discard</button></>)}
              <select value={editor} onChange={(e) => setEditor(e.target.value)} aria-label="Editor">{EDITORS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <button onClick={() => void bridge().shell.openExternal(EDITORS.find((x) => x.id === editor)!.url(abs)).catch((e) => setMsg(String(e)))}>Open in editor</button>
            </div>
            {conflict && (
              <div className="banner warn" role="alert">
                This file changed on disk after you opened it, so your save was refused.
                <button onClick={() => void openFile(file.filePath)}>Reload (discard my edit)</button>
              </div>
            )}
            {msg && <div className="muted pad">{msg}</div>}
            <div className="file-body">
              {file.isBinary && !isImage && <div className="empty">Binary file, {file.byteLength} bytes</div>}
              {isImage && <img alt={file.filePath} src={`data:${file.mimeType};base64,${file.content}`} className="preview-img" />}
              {!file.isBinary && !isImage && draft !== null && <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="Edit file" />}
              {!file.isBinary && !isImage && draft === null && (isMd && markdownView ? <div className="pad"><Markdown text={file.content ?? ""} /></div> : <CodeView code={file.content ?? ""} path={file.filePath} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { DaemonConn } from "../lib/rpc.ts";

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

interface SharedDocument { path: string; id: string; version: number; at: string; by: string; deleted?: boolean }
interface SharedVersion { version: number; at: string; by: string; sha256: string; bytes: number; mtimeMs: number; stored: boolean; deleted?: boolean }
type Viewed = { content?: string; base64?: string; tooLarge?: boolean; bytes: number };

export function SharedFiles({ conn, id, refresh }: { conn?: DaemonConn; id: string; refresh: unknown }) {
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [openPath, setOpenPath] = useState<string>();
  const [history, setHistory] = useState<SharedVersion[] | undefined>();
  const [viewed, setViewed] = useState<{ path: string; version: number; data: Viewed }>();
  const [status, setStatus] = useState("");
  const listGeneration = useRef(0), historyGeneration = useRef(0);

  const loadList = async () => {
    if (!conn) return;
    const g = ++listGeneration.current;
    try {
      const r = await conn.request<{ documents: SharedDocument[] }>("list_shared_documents", { id });
      if (g !== listGeneration.current) return;
      setDocuments(r.documents);
      setError(""); setLoaded(true);
    } catch (e) {
      if (g !== listGeneration.current) return;
      setError((e as Error).message); setLoaded(true);
    }
  };

  const loadHistory = async (path: string) => {
    if (!conn) return;
    const g = ++historyGeneration.current;
    try {
      const r = await conn.request<{ versions: SharedVersion[] }>("get_shared_history", { id, path });
      if (g !== historyGeneration.current) return;
      setHistory(r.versions);
      setError("");
    } catch (e) {
      if (g !== historyGeneration.current) return;
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setLoaded(false);
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, id, refresh]);

  const toggle = async (doc: SharedDocument) => {
    setViewed(undefined); setStatus("");
    if (openPath === doc.path) { setOpenPath(undefined); setHistory(undefined); return; }
    setOpenPath(doc.path); setHistory(undefined);
    await loadHistory(doc.path);
  };

  const view = async (path: string, version: number) => {
    if (viewed?.path === path && viewed.version === version) { setViewed(undefined); return; }
    if (!conn) return;
    try {
      const r = await conn.request<Viewed>("get_shared_version", { id, path, version });
      setViewed({ path, version, data: r });
      setError("");
    } catch (e) { setError((e as Error).message); }
  };

  const restore = async (path: string, version: number) => {
    if (!conn) return;
    if (!confirm(`Restore version ${version} of ${path}? The current file is kept as a version.`)) return;
    try {
      const r = await conn.request<{ document: { version: number } }>("restore_shared_version", { id, path, version });
      setStatus(`Restored version ${version} of ${path} as version ${r.document.version}.`);
      await loadList();
      if (openPath === path) await loadHistory(path);
      setError("");
    } catch (e) { setError((e as Error).message); }
  };

  return <section aria-label="Shared files">
    <h2>Shared files</h2>
    {error && <div className="banner error" role="alert">{error}</div>}
    {status && <p role="status">{status}</p>}
    {loaded && !documents.length && <p className="muted">No shared files yet.</p>}
    <ul className="plain-list cards">
      {documents.map((doc) => <li key={doc.path}>
        <button className="card-row" aria-expanded={openPath === doc.path} onClick={() => void toggle(doc)}>
          <strong>{doc.path}</strong><span>v{doc.version}</span><span>{doc.by}</span><span>{new Date(doc.at).toLocaleString()}</span>{doc.deleted && <span className="muted">(deleted)</span>}
        </button>
        {openPath === doc.path && history && <ol aria-label={`History of ${doc.path}`}>
          {history.map((v) => <li key={v.version}>
            <span>v{v.version}</span> <span>{v.by}</span> <span>{new Date(v.at).toLocaleString()}</span> <span>{formatSize(v.bytes)}</span>
            {v.deleted ? <span> deleted</span> : v.stored
              ? <span> <button onClick={() => void view(doc.path, v.version)}>View</button> <button onClick={() => void restore(doc.path, v.version)}>Restore</button></span>
              : <span className="muted"> No saved copy (too large)</span>}
            {viewed?.path === doc.path && viewed.version === v.version && <div>
              {viewed.data.tooLarge ? <p>Too large to show</p>
                : viewed.data.base64 ? <p>Binary file, {formatSize(viewed.data.bytes)}</p>
                : <pre className="pre-wrap">{viewed.data.content}</pre>}
            </div>}
          </li>)}
        </ol>}
      </li>)}
    </ul>
  </section>;
}

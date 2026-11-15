import { useEffect, useRef, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { Markdown } from "./Transcript.tsx";
import type { WikiIndex, WikiPage } from "../../../src/wiki/wiki.ts";

export function Wiki({ initialFolder }: { initialFolder?: string }) {
  const a = useApp(), [folder, setFolder] = useState(initialFolder ?? a.recentFolders[0] ?? ""), [query, setQuery] = useState(""), [pages, setPages] = useState<(WikiPage & { excerpt: string })[]>([]), [index, setIndex] = useState<WikiIndex>(), [text, setText] = useState(""), [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const generation = useRef(0), reading = useRef(0);
  const refresh = async () => {
    const version = ++generation.current; setError("");
    if (!folder.trim()) { setPages([]); setIndex(undefined); return; }
    try { const r = await app.request("list_wiki", { cwd: folder, query }); if (version === generation.current) { setPages(r.pages); setIndex(r.index); } }
    catch (e) { if (version === generation.current) { setError((e as Error).message); setPages([]); setIndex(undefined); } }
  };
  useEffect(() => { setSelected(""); setText(""); reading.current++; void refresh(); return () => { generation.current++; }; }, [folder, query]);
  const open = async (file: string) => { const version = ++reading.current; try { const r = await app.request("read_wiki_page", { cwd: folder, file }); if (version === reading.current) { setSelected(file); setText(r.text); } } catch (e) { if (version === reading.current) setError((e as Error).message); } };
  const build = async () => { setBusy(true); setError(""); try { const r = await app.request("build_wiki", { cwd: folder }); setNote(`${r.changed.length} pages refreshed; ${r.removed.length} removed.`); setText(""); setSelected(""); reading.current++; await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <section className="page"><h1>Wiki</h1><p>Local source-linked documentation in .rigwell/wiki. Build or update the selected repository, then search pages and open source citations. No model request or repository script runs during generation.</p>
    <label>Project folder<input aria-label="Wiki project folder" disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
    <button disabled={busy} onClick={() => void bridge().dialog.pickFolder().then((f) => { if (f) setFolder(f); })}>Choose wiki folder</button>
    <button disabled={busy || !folder.trim()} onClick={() => void build()}>{index ? "Update wiki" : "Build wiki"}</button>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
    {index ? <p>{index.files} files; {index.modules} modules. Source commit: <code>{index.head}</code>. Changes appear after Update wiki.</p> : <p>No wiki built for this folder.</p>}
    <label>Search wiki<input aria-label="Search wiki" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    {index?.warnings.length ? <details><summary>Coverage warnings ({index.warnings.length})</summary><ul>{index.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details> : null}
    <nav aria-label="Wiki pages"><ul>{pages.map((p) => <li key={p.file}><button aria-current={selected === p.file ? "page" : undefined} onClick={() => void open(p.file)}>{p.title}</button><p>{p.excerpt}</p></li>)}</ul>{index && !pages.length && <p>No wiki pages match.</p>}</nav>
    {text && <article aria-label="Wiki article"><Markdown text={text} /></article>}
  </section>;
}

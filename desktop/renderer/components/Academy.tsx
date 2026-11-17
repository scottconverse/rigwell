import { useEffect, useRef, useState } from "react";
import { app } from "../lib/app-model.ts";
import { Markdown } from "./Transcript.tsx";
import { ConfirmDialog } from "./Dialogs.tsx";
import type { Lesson } from "../../../src/academy/catalog.ts";
import type { readPractice } from "../../../src/academy/practice.ts";
type Practice = ReturnType<typeof readPractice>;

export function Academy({ go }: { go(route: string): void }) {
  const [lessons, setLessons] = useState<Lesson[]>([]), [selected, setSelected] = useState("getting-started"), [practice, setPractice] = useState<Practice>(), [practices, setPractices] = useState<{ id: string; lesson: string; root: string; passed?: boolean }[]>([]), [text, setText] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState(""), [removing, setRemoving] = useState<string>();
  const version = useRef(0), lesson = lessons.find((l) => l.id === selected);
  const refresh = async () => { const r = await app.request("list_lessons"); setLessons(r.lessons); setPractices(r.practices); };
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const run = async (f: () => Promise<void>) => { setBusy(true); setError(""); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const load = async (id: string) => { const seq = ++version.current; const r = await app.request<Practice>("read_lesson_practice", { id }); if (version.current === seq) { setSelected(r.lesson.id); setPractice(r); setText(r.content); setMessage(""); } };
  return <section className="page"><h1>Academy</h1><p>Offline Rigwell tutorials and disposable local practice repositories. Checks validate saved formats and sample Git state. They do not prove model access, hook execution, MCP connection, or live mission and automation results.</p>
    {error && <p role="alert">{error}</p>}
    <nav aria-label="Academy lessons"><ul>{lessons.map((l) => <li key={l.id}><button disabled={busy} aria-current={selected === l.id ? "page" : undefined} onClick={() => { version.current++; setSelected(l.id); setPractice(undefined); setText(""); setMessage(""); }}>{l.title}</button></li>)}</ul></nav>
    {lesson && <><article aria-label="Tutorial"><Markdown text={lesson.body} /></article><h2>Practice: {lesson.title}</h2><p>{lesson.goal}</p><button disabled={busy} onClick={() => void run(async () => { const r = await app.request<Practice>("start_lesson", { lesson: selected }); setPractice(r); setText(r.content); setMessage(""); await refresh(); })}>Start new practice</button></>}
    {practice && <section aria-label="Active practice"><p>Sample repository: <code>{practice.root}</code></p><p>File: <code>{practice.file}</code>. Your edits stay here; normal settings and other projects are untouched.</p>
      <label>Practice file<textarea aria-label="Practice file" rows={16} spellCheck={false} disabled={busy} value={text} onChange={(e) => { setText(e.target.value); setMessage(""); }} /></label>
      <button disabled={busy} onClick={() => void run(async () => { await app.request("save_lesson_practice", { id: practice.id, content: text }); setMessage("Practice saved."); await refresh(); })}>Save practice</button>
      <button disabled={busy} onClick={() => void run(async () => { await app.request("save_lesson_practice", { id: practice.id, content: text }); const r = await app.request("check_lesson_practice", { id: practice.id }); setMessage(`${r.passed ? "Practice passed" : "Needs changes"}: ${r.message}`); await refresh(); })}>Check practice</button>
      {practice.lesson.id === "worktrees" && <button disabled={busy} onClick={() => void run(async () => { const r = await app.request("create_lesson_worktree", { id: practice.id }); setMessage(`Created ${r.branch} at ${r.path}.`); })}>Create practice worktree</button>}
      <button disabled={busy} onClick={() => { app.rememberFolder(practice.root); go(`/?folder=${encodeURIComponent(practice.root)}`); }}>Open sample session</button>
      <button disabled={busy} onClick={() => setRemoving(practice.id)}>Remove active practice</button>
      <details><summary>Show a valid example</summary><pre>{practice.lesson.example}</pre><p>This demonstrates format only. Enter it or develop your own answer in the practice editor.</p></details>
      {message && <p role="status">{message}</p>}
    </section>}
    <h2>Saved practice repositories</h2><p>Temporary storage can be cleared by the operating system. Preserve useful edits elsewhere before cleanup.</p>
    <ul aria-label="Saved practices">{practices.map((p) => <li key={p.id}>{p.lesson}: {p.passed ? "Format check passed" : "Not checked or needs changes"} <code>{p.root}</code><button disabled={busy} onClick={() => void run(() => load(p.id))}>Resume {p.id}</button><button disabled={busy} onClick={() => setRemoving(p.id)}>Remove {p.id}</button></li>)}</ul>
    {removing && <ConfirmDialog title="Remove sample repository?" body="Delete this owned practice repository, its sample worktree and all your edits inside it. Preserve useful work elsewhere first." action="Remove sample" onCancel={() => setRemoving(undefined)} onConfirm={() => void run(async () => { await app.request("remove_lesson_practice", { id: removing, confirmed: true }); if (practice?.id === removing) { setPractice(undefined); setText(""); } setRemoving(undefined); await refresh(); })} />}
  </section>;
}

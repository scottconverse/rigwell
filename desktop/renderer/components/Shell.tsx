// Sidebar and command palette (spec §14.3).
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, groupByProject, projectName, runningWorkstreams, sessionStateLabel, sidebarRows, type SessionRow } from "../lib/sessions.ts";
import { app, useApp } from "../lib/app-model.ts";
import { projectArchiveTargets } from "../lib/sessions.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { useAddFolder } from "./Home.tsx";
import { MORE_PAGES, PALETTE_PAGES, SETTINGS_PAGES, matchesSettings } from "../lib/nav-pages.ts";

/** The other pages. Arrow keys move, Enter opens, Esc closes and returns to the button. */
function MoreMenu({ route, go }: { route?: string; go(r: string): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = MORE_PAGES.some((p) => route?.startsWith(p.route));
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items.at(-1)?.focus(); }
  };
  return (
    <div className="side-more" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button ref={button} className={`side-btn ${active ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>More</button>
      {open && <div className="menu" role="menu" aria-label="More pages">
        {MORE_PAGES.map((p) => <button key={p.id} role="menuitem" className={`menu-item ${route?.startsWith(p.route) ? "on" : ""}`} onClick={() => { setOpen(false); go(p.route); }}>{p.label}</button>)}
      </div>}
    </div>
  );
}

export function Sidebar({ hidden, sessions, current, daemon, route, go, openPalette }: { hidden?: boolean; sessions: SessionRow[]; current?: string; daemon: string; route?: string; go(r: string): void; openPalette(): void }) {
  const [group, setGroup] = useState(true);
  const [lookback, setLookback] = useState(30);
  const [project, setProject] = useState("");
  const adder = useAddFolder((p) => go(`/?folder=${encodeURIComponent(p)}`));
  const [rowMenu, setRowMenu] = useState<string | null>(null); // project whose row menu is open
  const [archiving, setArchiving] = useState<string | null>(null); // project waiting for the confirmation
  const [note, setNote] = useState("");
  // Pinned first, archived and subagent sessions hidden (spec §14.3, §12.1).
  const rows = useMemo(() => sidebarRows(sessions, { lookbackDays: lookback, project }), [sessions, lookback, project]);
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean) as string[])], [sessions]);
  const groups = useMemo(() => (group ? groupByProject(rows) : ([["all", rows]] as [string, SessionRow[]][])), [rows, group]);
  const workstreams = runningWorkstreams(useApp().workstreams);
  return (
    <nav className="sidebar" aria-label="Sidebar" hidden={hidden}>
      <div className="side-top drag">
        <button className="side-btn primary" onClick={() => go("/")}>New Session</button>
        <button className="side-btn" onClick={openPalette}>Search <kbd>Ctrl+K</kbd></button>
        <button className={`side-btn ${route?.startsWith("/missions") ? "on" : ""}`} onClick={() => go("/missions")}>Mission Control</button>
        <MoreMenu route={route} go={go} />
      </div>
      <div className="side-filters">
        <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))} aria-label="Last activity"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>All</option></select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project"><option value="">All projects</option>{projects.map((p) => <option key={p} value={p}>{projectName(p)}</option>)}</select>
        <label className="check small"><input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />Group</label>
        <button className="small" title="Add a project folder" aria-label="Add folder" onClick={() => void adder.pick()}>Add folder</button>
      </div>
      <div className="side-list">
        {workstreams.length > 0 && <section className="side-group" aria-label="Running workstreams">
          <div className="side-group-head"><span>Running workstreams</span></div>
          {workstreams.map((w) => (
            <button key={w.id} className={`side-row ${route === `/workstreams/${w.id}` ? "on" : ""}`} onClick={() => go(`/workstreams/${w.id}`)}>
              <span className="side-title">{w.title}</span><span className="side-meta"><span className={`live-state ${w.state === "active" ? "working" : ""}`}>{w.state === "active" ? "Running" : "Paused"}</span></span>
            </button>
          ))}
        </section>}
        {groups.map(([k, list]) => (
          <div key={k} className="side-group">
            {group && <div className="side-group-head"><span>{projectName(k)}</span><span className="spacer" />
              <span className="chip-wrap">
                <button title="Project menu" aria-label={`Menu for ${projectName(k)}`} aria-haspopup="menu" aria-expanded={rowMenu === k} onClick={() => setRowMenu(rowMenu === k ? null : k)}>...</button>
                {rowMenu === k && <div className="menu right" role="menu" aria-label="Project menu"><button role="menuitem" className="menu-item" onClick={() => { setRowMenu(null); setArchiving(k); }}>Archive Project</button></div>}
              </span>
              <button title="New session in this project" aria-label={`New session in ${projectName(k)}`} onClick={() => go(`/?folder=${encodeURIComponent(k)}`)}>+</button></div>}
            {list.map((s) => (
              <button key={s.id} className={`side-row ${s.id === current ? "on" : ""}`} onClick={() => go(`/sessions/${s.id}`)} title={s.cwd}>
                <span className="side-title">{s.pinned && <span className="pin" title="Pinned" aria-label="Pinned">* </span>}{s.title}{s.source && <span className="badge" aria-label="Session source">{s.source === "slack" ? "Slack" : "Teams"}</span>}</span>
                <span className="side-meta"><span className={`live-state ${s.state ?? "idle"}`} data-testid="session-state">{sessionStateLabel(s)}</span><span className="muted small">{ago(s.updatedAt)}</span></span>
              </button>
            ))}
          </div>
        ))}
        {!rows.length && <div className="muted pad">No sessions yet</div>}
      </div>
      <div className="side-foot">
        <span className={`dot ${daemon}`} title={`Background service: ${daemon}`} />
        <span className="muted small">{daemon === "running" ? "Local" : daemon}</span>
        <span className="spacer" />
        <button aria-label="Settings" onClick={() => go("/settings/general")}>Settings</button>
      </div>
      {adder.dialog}
      {note && <div className="toast" role="status">{note}</div>}
      {archiving !== null && (
        <ConfirmDialog title={`Archive ${projectName(archiving)}?`} action="Archive Project"
          body={`${projectArchiveTargets(sessions, archiving).length} session(s) in this project will be archived. You can unarchive them in Settings > Session management.`}
          onCancel={() => setArchiving(null)}
          onConfirm={() => { const p = archiving; setArchiving(null); void app.archiveProject(p).then((n) => { setNote(`Archived ${n} session${n === 1 ? "" : "s"}`); setTimeout(() => setNote(""), 2500); }).catch((e) => { setNote((e as Error).message); setTimeout(() => setNote(""), 3500); }); }} />
      )}
    </nav>
  );
}

type PalTab = "All" | "Sessions" | "Pages" | "Settings" | "Actions";
export function Palette({ sessions, go, close, actions }: { sessions: SessionRow[]; go(r: string): void; close(): void; actions: { id: string; label: string; run(): void }[] }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<PalTab>("All");
  const [look, setLook] = useState(30);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const pages = PALETTE_PAGES.map((p) => ({ id: p.id, label: p.palette, run: () => go(p.route) }));
  const items = useMemo(() => {
    const ql = q.toLowerCase();
    const sess = sessions.filter((s) => s.archivedAt == null && !s.isSubagent && (!look || Date.now() - s.updatedAt < look * 86400_000) && `${s.title} ${s.cwd ?? ""}`.toLowerCase().includes(ql)).slice(0, 30).map((s) => ({ id: s.id, label: s.title, sub: projectName(s.cwd), kind: "Sessions" as PalTab, run: () => go(`/sessions/${s.id}`) }));
    const match = (l: string) => l.toLowerCase().includes(ql);
    const all = [
      ...sess,
      ...pages.filter((p) => match(p.label)).map((p) => ({ ...p, sub: "", kind: "Pages" as PalTab })),
      ...SETTINGS_PAGES.filter((p) => match(`Settings: ${p.label}`) || matchesSettings(p, q)).map((p) => ({ id: p.id, label: `Settings: ${p.label}`, run: () => go(`/settings/${p.id}`), sub: "", kind: "Settings" as PalTab })),
      ...actions.filter((p) => match(p.label)).map((p) => ({ ...p, sub: "", kind: "Actions" as PalTab })),
    ];
    return tab === "All" ? all : all.filter((x) => x.kind === tab);
  }, [q, tab, look, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSel(0), [q, tab]);
  const run = (i: number) => { items[i]?.run(); close(); };
  return (
    <div className="overlay top" onClick={close}>
      <div className="palette" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions, pages, settings and actions" aria-label="Search"
          onKeyDown={(e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); } else if (e.key === "Enter") run(sel); }} />
        <div className="pal-tabs" role="tablist">
          {(["All", "Sessions", "Pages", "Settings", "Actions"] as PalTab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
          <span className="spacer" />
          <select value={look} onChange={(e) => setLook(Number(e.target.value))} aria-label="Look back"><option value={7}>7d</option><option value={30}>30d</option><option value={90}>90d</option><option value={0}>All</option></select>
        </div>
        <div className="pal-list" role="listbox">
          {items.map((it, i) => <button key={`${it.kind}-${it.id}`} role="option" aria-selected={i === sel} className={`pal-item ${i === sel ? "on" : ""}`} onClick={() => run(i)}><span>{it.label}</span><span className="muted small">{it.sub || it.kind}</span></button>)}
          {!items.length && <div className="muted pad">Nothing found</div>}
        </div>
      </div>
    </div>
  );
}

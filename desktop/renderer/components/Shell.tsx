// Sidebar and command palette (spec §14.3).
import { useEffect, useMemo, useRef, useState } from "react";
import { ago, groupByProject, projectName, runningWorkstreams, sessionStateLabel, sidebarRows, splitPinned, type SessionRow } from "../lib/sessions.ts";
import { app, useApp } from "../lib/app-model.ts";
import { SETUP_LABELS, setupSteps } from "../lib/setup-steps.ts";
import { projectArchiveTargets } from "../lib/sessions.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { useAddFolder } from "./Home.tsx";
import { MORE_PAGES, PALETTE_PAGES, SETTINGS_PAGES, matchesSettings } from "../lib/nav-pages.ts";
import { ICONS24, NavIcon } from "./NavIcon.tsx";

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
      <button ref={button} className={`side-btn ${active ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><NavIcon d={ICONS24.more} grid={24} size={16} />More</button>
      {open && <div className="menu" role="menu" aria-label="More pages">
        {MORE_PAGES.map((p) => <button key={p.id} role="menuitem" className={`menu-item ${route?.startsWith(p.route) ? "on" : ""}`} onClick={() => { setOpen(false); go(p.route); }}>{p.label}</button>)}
      </div>}
    </div>
  );
}

/** One session in the sidebar. Pinned rows draw a pin icon instead of a star. */
function SessionRowView({ s, current, child, go }: { s: SessionRow; current?: string; child?: boolean; go(r: string): void }) {
  return (
    <button className={`side-row ${child ? "child" : ""} ${s.id === current ? "on" : ""}`} onClick={() => go(`/sessions/${s.id}`)} title={s.cwd}>
      <span className="side-title">{s.pinned && <span className="pin" title="Pinned" aria-label="Pinned"><NavIcon d={ICONS24.pin} grid={24} size={12} /></span>}{s.title}{s.source && <span className="badge" aria-label="Session source">{s.source === "slack" ? "Slack" : "Teams"}</span>}</span>
      <span className="side-meta"><span className={`live-state ${s.state ?? "idle"}`} data-testid="session-state">{sessionStateLabel(s)}</span><span className="muted small">{ago(s.updatedAt)}</span></span>
    </button>
  );
}

/** The project filters, opened from the Projects header. Esc and a click outside close it. */
function FilterMenu({ group, setGroup, lookback, setLookback, project, setProject, projects }: { group: boolean; setGroup(v: boolean): void; lookback: number; setLookback(v: number): void; project: string; setProject(v: string): void; projects: string[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); } };
  return (
    <div className="side-filter" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button ref={button} className="side-icon-btn" aria-label="Filter projects" title="Filter projects" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><NavIcon d={ICONS24.more} grid={24} /></button>
      {open && <div className="menu right" role="menu" aria-label="Project filters" onKeyDown={onKey}>
        <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))} aria-label="Last activity"><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>All</option></select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project"><option value="">All projects</option>{projects.map((p) => <option key={p} value={p}>{projectName(p)}</option>)}</select>
        <label className="check small"><input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />Group</label>
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
  const [closed, setClosed] = useState<Set<string>>(new Set()); // project groups folded shut
  const toggleGroup = (k: string) => setClosed((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // Pinned first, archived and subagent sessions hidden (spec §14.3, §12.1).
  const rows = useMemo(() => sidebarRows(sessions, { lookbackDays: lookback, project }), [sessions, lookback, project]);
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean) as string[])], [sessions]);
  // Pinned sessions get their own section, so they do not also show in a project group.
  const { pinned, rest } = useMemo(() => splitPinned(rows), [rows]);
  const groups = useMemo(() => (group ? groupByProject(rest) : ([["all", rest]] as [string, SessionRow[]][])), [rest, group]);
  const st = useApp();
  const workstreams = runningWorkstreams(st.workstreams);
  // Refresh the tool count when the route changes (for example after adding a server in Settings).
  useEffect(() => { void app.refreshTools(); }, [route]);
  const setup = setupSteps({ models: st.models.length, hasSession: sessions.some((s) => !!s.cwd && s.archivedAt == null && !s.isSubagent), tools: st.toolCount });
  return (
    <nav className="sidebar" aria-label="Sidebar" hidden={hidden}>
      <div className="side-top drag">
        <button className="side-btn primary" onClick={() => go("/")}><NavIcon d={ICONS24.plus} grid={24} size={16} />New Session</button>
        <button className={`side-btn ${route?.startsWith("/automations") ? "on" : ""}`} onClick={() => go("/automations")}><NavIcon d={ICONS24.sync} grid={24} size={16} />Automations</button>
        <button className="side-btn" onClick={openPalette}><NavIcon d={ICONS24.search} grid={24} size={16} />Search <kbd>Ctrl+K</kbd></button>
        <button className={`side-btn ${route?.startsWith("/missions") ? "on" : ""}`} onClick={() => go("/missions")}><NavIcon d={ICONS24.flag} grid={24} size={16} />Mission Control</button>
        <MoreMenu route={route} go={go} />
      </div>
      <div className="side-list">
        {pinned.length > 0 && <div className="side-group">
          <div className="side-sect"><span>Pinned</span></div>
          {pinned.map((s) => <SessionRowView key={s.id} s={s} current={current} go={go} />)}
        </div>}
        <div className="side-group">
          <div className="side-sect">
            <span>Workstreams <span className="beta">Beta</span></span>
            <button className="side-icon-btn" aria-label="New workstream" title="New workstream" onClick={() => go("/workstreams/new")}><NavIcon d={ICONS24.plus} grid={24} /></button>
          </div>
          <section aria-label="Running workstreams">
            {workstreams.map((w) => (
              <button key={w.id} className={`side-row ${route === `/workstreams/${w.id}` ? "on" : ""}`} onClick={() => go(`/workstreams/${w.id}`)}>
                <span className="side-title"><NavIcon d={ICONS24.flag} grid={24} />{w.title}</span><span className="side-meta"><span className={`live-state ${w.state === "active" ? "working" : ""}`}>{w.state === "active" ? "Running" : "Paused"}</span></span>
              </button>
            ))}
            {!workstreams.length && <div className="muted small side-empty">No workstreams running</div>}
          </section>
        </div>
        <div className="side-group">
          <div className="side-sect">
            <span>Projects</span>
            <span className="side-sect-actions">
              <FilterMenu group={group} setGroup={setGroup} lookback={lookback} setLookback={setLookback} project={project} setProject={setProject} projects={projects} />
              <button className="side-icon-btn" title="Add a project folder" aria-label="Add folder" onClick={() => void adder.pick()}><NavIcon d={ICONS24.folder} grid={24} /></button>
            </span>
          </div>
          {groups.map(([k, list]) => (
            <div key={k} className="side-group">
              {group && <div className="side-group-head">
                <button className="side-fold" aria-expanded={!closed.has(k)} onClick={() => toggleGroup(k)}><NavIcon d={ICONS24.folder} grid={24} /><span className="side-title">{projectName(k)}</span></button>
                <span className="spacer" />
                <span className="chip-wrap">
                  <button title="Project menu" aria-label={`Menu for ${projectName(k)}`} aria-haspopup="menu" aria-expanded={rowMenu === k} onClick={() => setRowMenu(rowMenu === k ? null : k)}>...</button>
                  {rowMenu === k && <div className="menu right" role="menu" aria-label="Project menu"><button role="menuitem" className="menu-item" onClick={() => { setRowMenu(null); setArchiving(k); }}>Archive Project</button></div>}
                </span>
                <button title="New session in this project" aria-label={`New session in ${projectName(k)}`} onClick={() => go(`/?folder=${encodeURIComponent(k)}`)}>+</button></div>}
              {(!group || !closed.has(k)) && list.map((s) => <SessionRowView key={s.id} s={s} current={current} child={group} go={go} />)}
            </div>
          ))}
          {!rows.length && <div className="muted pad">No sessions yet</div>}
        </div>
      </div>
      {setup && setup.next && <div className="setup" aria-label="Finish setup">
        <div className="h"><span>Finish setup</span><span className="muted">{setup.done}/{setup.total}</span></div>
        <button data-setup={setup.next} onClick={() => setup.next === "model" ? go("/settings/model-setup") : setup.next === "session" ? void adder.pick() : go("/settings/connectors")}>{SETUP_LABELS[setup.next]}</button>
      </div>}
      <div className="side-foot">
        <span className={`dot ${daemon}`} title={`Background service: ${daemon}`} />
        <span className="muted small">{daemon === "running" ? "Local" : daemon}</span>
        <span className="spacer" />
        <button className="side-icon-btn" aria-label="Settings" title="Settings" onClick={() => go("/settings/general")}><NavIcon d={ICONS24.gear} grid={24} /></button>
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

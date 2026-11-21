import { FleetMachines } from "./components/Machines.tsx";
import { SharedSessions } from "./components/SharedSessions.tsx";
import { Sync } from "./components/Sync.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { Plugins } from "./components/Plugins.tsx";
import { Wiki } from "./components/Wiki.tsx";
import { Academy } from "./components/Academy.tsx";
import { Analytics } from "./components/Analytics.tsx";
import { Evaluations } from "./components/Evaluations.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Automations, AutomationDetail } from "./components/Automations.tsx";
import { TrustAsks } from "./components/Dialogs.tsx";
import { Home } from "./components/Home.tsx";
import { Missions, MissionDetailPage } from "./components/Missions.tsx";
import { Workstreams } from "./components/Workstreams.tsx";
import { Review } from "./components/Review.tsx";
import { SessionScreen } from "./components/SessionScreen.tsx";
import { Settings } from "./components/Settings.tsx";
import { Palette, Sidebar } from "./components/Shell.tsx";
import { app, useApp } from "./lib/app-model.ts";
import { applyAppearance } from "./lib/appearance.ts";
import { bridge } from "./lib/rpc.ts";
import { canGoBack, canGoForward, currentRoute, startHistory, stepBack, stepForward, visit, type NavHistory } from "./lib/nav-history.ts";
import { NavIcon } from "./components/NavIcon.tsx";
import { UpdateButton } from "./components/UpdateButton.tsx";
import { installRendererCrashCapture } from "./lib/crashes.ts";
installRendererCrashCapture((value) => bridge().diagnostics.rendererCrash(value));

/** Hash routing: #/ , #/sessions/<id> , #/settings/<page> (spec §14.2: packaged builds load index.html with hash routes). */
function useRoute() {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read());
  const history = useRef<NavHistory>(startHistory(route));
  const [, redraw] = useState(0);
  const record = useCallback((next: NavHistory) => { history.current = next; redraw((n) => n + 1); }, []);
  // Back and Forward move the index first, so the hash change that follows is not a new visit.
  useEffect(() => { const h = () => { const r = read(); setRoute(r); record(visit(history.current, r)); }; window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h); }, [record]);
  const go = useCallback((r: string) => { window.location.hash = r; }, []);
  const move = useCallback((next: NavHistory) => { if (next === history.current) return; record(next); window.location.hash = currentRoute(next); }, [record]);
  const back = useCallback(() => move(stepBack(history.current)), [move]);
  const forward = useCallback(() => move(stepForward(history.current)), [move]);
  return { route, go, back, forward, canBack: canGoBack(history.current), canForward: canGoForward(history.current) };
}

function Audio() {
  useEffect(() => bridge().audio.onPlay(({ kind, url, volume }) => {
    if (kind === "bell" || !url) {
      try {
        const ctx = new AudioContext();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 1000; g.gain.value = 0.2 * (volume / 100);
        o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12);
      } catch {}
      return;
    }
    const el = new window.Audio(url);
    el.volume = Math.min(1, Math.max(0, volume / 100));
    void el.play().catch(() => {});
  }), []);
  return null;
}

function App() {
  const a = useApp();
  const { route, go, back, forward, canBack, canForward } = useRoute();
  const sidebarHidden = a.settings?.sidebarHidden === true;
  const [palette, setPalette] = useState(false);
  const [path, query] = route.split("?");
  const parts = path.split("/").filter(Boolean);

  useEffect(() => { void app.start(); }, []);
  useEffect(() => bridge().nav.onGo((r) => go(r)), [go]);
  useEffect(() => { if (a.settings) applyAppearance(a.settings.appearance); }, [a.settings?.appearance]); // eslint-disable-line react-hooks/exhaustive-deps
  // "system" follows the OS live
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => { if (a.settings?.appearance.theme === "system") applyAppearance(a.settings.appearance); };
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [a.settings]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); go("/"); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);
  useEffect(() => { if (parts[0] !== "sessions") void bridge().view.set(null); }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionId = parts[0] === "sessions" ? parts[1] : undefined;
  const folder = new URLSearchParams(query ?? "").get("folder") ?? undefined;
  return (
    <div className={`app ${sidebarHidden ? "no-sidebar" : ""} ${navigator.userAgent.includes("Mac") ? "mac" : ""}`}>
      <Sidebar hidden={sidebarHidden} sessions={a.sessions} current={sessionId} daemon={a.daemon.state} route={path} go={go} openPalette={() => setPalette(true)} />
      <main className="content">
        <div className="titlebar drag" role="toolbar" aria-label="Navigation">
          <button aria-label="Back" title="Back" disabled={!canBack} onClick={back}><NavIcon d="M10 3L5 8l5 5" /></button>
          <button aria-label="Forward" title="Forward" disabled={!canForward} onClick={forward}><NavIcon d="M6 3l5 5-5 5" /></button>
          <button aria-label={sidebarHidden ? "Show Sidebar" : "Hide Sidebar"} title={sidebarHidden ? "Show Sidebar" : "Hide Sidebar"} onClick={() => void app.updateSettings({ sidebarHidden: !sidebarHidden })}><NavIcon d="M2 3h12v10H2zM6 3v10" /></button>
          <UpdateButton />
        </div>
        {parts[0] === "settings" ? <Settings page={parts[1] ?? "general"} go={go} />
          : parts[0] === "missions" ? (parts[1] ? <MissionDetailPage key={parts[1]} sessionId={parts[1]} go={go} /> : <Missions go={go} />)
          : parts[0] === "workstreams" ? <Workstreams key={parts[1] ?? "list"} id={parts[1]} go={go} />
          : parts[0] === "machines" ? <FleetMachines />
          : parts[0] === "imports" ? <SharedSessions id={parts[1]} go={go} />
          : parts[0] === "sync" ? <Sync go={go} />
          : parts[0] === "inbox" ? <Inbox go={go} />
          : parts[0] === "plugins" ? <Plugins />
          : parts[0] === "wiki" ? <Wiki initialFolder={folder} />
          : parts[0] === "academy" ? <Academy go={go} />
          : parts[0] === "analytics" ? <Analytics />
          : parts[0] === "eval" ? <Evaluations />
          : parts[0] === "review" ? <Review initialFolder={folder} go={go} />
          : parts[0] === "automations" ? (parts[1] ? <AutomationDetail key={parts[1]} id={parts[1]} go={go} /> : <Automations go={go} />)
          : sessionId ? <SessionScreen key={sessionId} sessionId={sessionId} /> : <Home key={folder ?? "home"} go={go} initialFolder={folder} initialMission={new URLSearchParams(query ?? "").get("mode") === "mission"} />}
      </main>
      {palette && <Palette sessions={a.sessions} go={go} close={() => setPalette(false)} actions={[
        { id: "new", label: "Create new session", run: () => go("/") },
        { id: "restart", label: "Restart background service", run: () => void bridge().daemon.restart() },
      ]} />}
      <Audio />
      <TrustAsks />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

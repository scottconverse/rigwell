import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Home } from "./components/Home.tsx";
import { SessionScreen } from "./components/SessionScreen.tsx";
import { Settings } from "./components/Settings.tsx";
import { Palette, Sidebar } from "./components/Shell.tsx";
import { app, useApp } from "./lib/app-model.ts";
import { applyAppearance } from "./lib/appearance.ts";
import { bridge } from "./lib/rpc.ts";

/** Hash routing: #/ , #/sessions/<id> , #/settings/<page> (spec §14.2: packaged builds load index.html with hash routes). */
function useRoute() {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read());
  useEffect(() => { const h = () => setRoute(read()); window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h); }, []);
  const go = useCallback((r: string) => { window.location.hash = r; }, []);
  return { route, go };
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
  const { route, go } = useRoute();
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
    <div className="app">
      <Sidebar sessions={a.sessions} current={sessionId} daemon={a.daemon.state} go={go} openPalette={() => setPalette(true)} />
      <main className="content">
        <div className="titlebar drag" aria-hidden />
        {parts[0] === "settings" ? <Settings page={parts[1] ?? "general"} go={go} /> : sessionId ? <SessionScreen key={sessionId} sessionId={sessionId} /> : <Home key={folder ?? "home"} go={go} initialFolder={folder} />}
      </main>
      {palette && <Palette sessions={a.sessions} go={go} close={() => setPalette(false)} actions={[
        { id: "new", label: "Create new session", run: () => go("/") },
        { id: "restart", label: "Restart background service", run: () => void bridge().daemon.restart() },
      ]} />}
      <Audio />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

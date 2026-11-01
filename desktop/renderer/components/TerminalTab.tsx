// Terminal tab (spec §17.2): xterm.js in the page, the shell in the daemon. The terminal id is stable per session, so after
// a window reload the tab lists the daemon's terminals, adopts this one and repaints from the scrollback it returns.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { SessionController } from "../lib/session.ts";

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function TerminalTab({ ctl, active }: { ctl: SessionController; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("");
  const sessionId = ctl.getSnapshot().sessionId!;
  const terminalId = `term-${sessionId.slice(0, 8)}-1`;

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true, scrollback: 10_000, fontSize: 13, convertEol: false,
      fontFamily: css("--rw-font-code", "monospace"),
      theme: { background: css("--bg-panel", "#1b1a19"), foreground: css("--fg", "#eee"), cursor: css("--accent", "#7aa2f7") },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    let dead = false;
    const off = ctl.onTerminal((n) => {
      if (n.terminalId !== terminalId) return;
      if (n.type === "daemon.terminal_data") term.write(n.data);
      else { term.write(`\r\n[process exited with code ${n.exitCode}]\r\n`); setStatus("exited"); }
    });
    (async () => {
      try {
        const { terminals } = await ctl.request("daemon.list_terminals");
        const mine = terminals.find((t: any) => t.id === terminalId);
        if (mine) {
          term.resize(mine.cols, mine.rows);
          term.write(mine.state.serialized); // repaint the scrollback after a reload
          fit.fit();
          setStatus("reattached");
        } else {
          const r = await ctl.request("daemon.create_terminal", { terminalId, cols: term.cols, rows: term.rows });
          if (!r.success) setStatus(String(r.error));
        }
        await ctl.request("daemon.resize_terminal", { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch (e) { if (!dead) setStatus((e as Error).message); }
    })();
    const d1 = term.onData((data) => { void ctl.request("daemon.write_terminal_data", { terminalId, data }).catch(() => {}); });
    const d2 = term.onResize(({ cols, rows }) => { void ctl.request("daemon.resize_terminal", { terminalId, cols, rows }).catch(() => {}); });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host.current!);
    return () => { dead = true; off(); d1.dispose(); d2.dispose(); ro.disconnect(); term.dispose(); };
  }, [ctl, terminalId]);

  useEffect(() => { if (active) { try { fitRef.current?.fit(); } catch {} host.current?.querySelector("textarea")?.focus(); } }, [active]);

  return (
    <div className="terminal-wrap">
      <div ref={host} className="terminal" data-testid="terminal" />
      {status && <div className="terminal-status muted">{status}</div>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
// @ts-expect-error Upstream ships browser JavaScript without declarations.
import RFB from "@novnc/novnc";
import { bridge } from "../lib/rpc.ts";
import { RemoteChannel } from "../lib/remote-channel.ts";
import { BrowserTab } from "./BrowserTab.tsx";

export function RemoteViewer({ machine, kind, visible }: { machine: string; kind: "browser" | "desktop"; visible: boolean }) {
  const [port, setPort] = useState(kind === "desktop" ? "5900" : "3000"), [error, setError] = useState("");
  const [connection, setConnection] = useState<{ id?: string; url?: string; port: number }>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [credentials, setCredentials] = useState(false), [password, setPassword] = useState("");
  const screen = useRef<HTMLDivElement>(null), rfb = useRef<any>(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!connection) return;
    if (kind === "browser") return () => { if (connection.id) void bridge().remoteView.close(connection.id).catch(() => {}); };
    const channel = new RemoteChannel(machine, connection.port);
    const viewer = new RFB(screen.current!, channel, { shared: true });
    rfb.current = viewer; viewer.scaleViewport = true; viewer.viewOnly = true;
    viewer.addEventListener("connect", () => setStatus("Connected (view only)"));
    viewer.addEventListener("disconnect", (event: CustomEvent) => { setStatus("Disconnected"); if (!event.detail.clean) setError("The remote desktop connection ended"); });
    viewer.addEventListener("credentialsrequired", () => setCredentials(true));
    viewer.addEventListener("securityfailure", (event: CustomEvent) => setError(event.detail.reason ?? "VNC authentication failed"));
    // noVNC attaches its raw-channel handlers on a scheduled task before reading bytes.
    const timer = setTimeout(() => { void channel.start(); });
    return () => { clearTimeout(timer); viewer.disconnect(); channel.close(); rfb.current = null; setCredentials(false); setPassword(""); };
  }, [connection, machine, kind]);
  const connect = async () => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) { setError("Enter a port between 1 and 65535"); return; }
    setBusy(true); setError(""); const token = ++generation.current;
    try {
      const result: { id?: string; url?: string } = kind === "browser" ? await bridge().remoteView.open(machine, n, "browser") : {};
      if (generation.current !== token) { if ("id" in result && result.id) await bridge().remoteView.close(result.id); return; }
      setConnection({ ...result, port: n }); setStatus("Connecting");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div style={{ display: visible ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
    <div className="addrbar"><label>Remote loopback port <input aria-label="Remote port" value={port} disabled={!!connection || busy} onChange={(e) => setPort(e.target.value)} /></label>
      {connection ? <button onClick={() => { generation.current++; setConnection(undefined); }}>Disconnect</button> : <button disabled={busy} onClick={() => void connect()}>Connect</button>}
      {kind === "desktop" && <span>{status}</span>}
    </div>
    {!connection && <p>{kind === "desktop" ? "Connect to a VNC server you run on this machine. The viewer uses SSH and starts in view-only mode." : "Open a service on this machine through SSH."}</p>}
    {error && <p role="alert">{error}</p>}
    {credentials && <form onSubmit={(e) => { e.preventDefault(); rfb.current?.sendCredentials({ password }); setPassword(""); setCredentials(false); }}><label>VNC password <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button>Authenticate</button></form>}
    {connection && kind === "browser" && <BrowserTab key={connection.id} visible={visible} initialUrl={connection.url} onWantVisible={() => {}} />}
    {connection && kind === "desktop" && <label><input type="checkbox" onChange={(e) => { if (rfb.current) rfb.current.viewOnly = !e.target.checked; }} />Enable keyboard and pointer input</label>}
    <div ref={screen} style={{ display: kind === "desktop" && connection ? "flex" : "none", flex: 1, minHeight: 0, overflow: "hidden" }} aria-label="Remote desktop screen" />
  </div>;
}

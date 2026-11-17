import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import { ConfirmDialog } from "./Dialogs.tsx";

interface Status { remoteAccessEnabled: boolean; listening: boolean; host: string; port: number; url?: string; fingerprint?: string; interfaces: string[]; devices: { id: string; name: string; createdAt: number; lastSeenAt?: number; revokedAt?: number; expiresAt: number }[] }
interface Pair { qr: string; code: string; url: string; fingerprint: string; expiresAt: number }
export function PhoneAccessPage() {
  const [status, setStatus] = useState<Status>(), [host, setHost] = useState("127.0.0.1"), [port, setPort] = useState("47823"), [pair, setPair] = useState<Pair>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const apply = (s: Status) => { setStatus(s); setHost(s.host); setPort(String(s.port)); };
  const run = async (action: () => Promise<void>) => { setError(""); setBusy(true); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { void run(async () => apply(await app.request("phone_status"))); }, []);
  const configure = (enabled: boolean) => run(async () => { apply(await app.request("phone_configure", { config: { remoteAccessEnabled: enabled, host, port: Number(port) } })); setPair(undefined); });
  return <div className="page" aria-label="Phone access settings"><h1>Phone access</h1>
    <p>{status?.listening ? "Encrypted phone access is running" : "Phone access is off"}. Only paired devices can open sessions or send commands.</p>
    {error && <div className="banner error" role="alert">{error}</div>}
    <label>Network interface<select aria-label="Phone network interface" value={host} onChange={(e) => setHost(e.target.value)}>{(status?.interfaces ?? [host]).map((ip) => <option key={ip} value={ip}>{ip}</option>)}</select></label>
    <label>Port<input aria-label="Phone port" type="number" min={0} max={65535} value={port} onChange={(e) => setPort(e.target.value)} /></label>
    <button disabled={busy || !status} onClick={() => setConfirming(true)}>{status?.listening ? "Apply phone access address" : "Enable phone access"}</button>
    <button disabled={busy || !status?.remoteAccessEnabled} onClick={() => void configure(false)}>Disable phone access</button>
    <button disabled={busy || !status?.listening} onClick={() => void run(async () => setPair(await app.request("phone_pair")))}>Pair a device</button>
    <button disabled={busy} onClick={() => void run(async () => apply(await app.request("phone_status")))}>Refresh devices</button>
    {status?.url && <p>Address: {status.url}</p>}{status?.fingerprint && <><h2>Server certificate fingerprint (SHA-256)</h2><pre className="pre">{status.fingerprint}</pre></>}
    {pair && <section aria-label="One-time phone pairing"><h2>Scan to pair</h2><img src={pair.qr} alt="One-time phone pairing QR code" width={320} height={320} /><p>Expires: {new Date(pair.expiresAt).toLocaleTimeString()}</p><p>One-time code: <code>{pair.code}</code></p><p className="pre">{pair.url}</p><p>Verify this computer's certificate fingerprint in the phone browser before accepting the self-signed certificate. Pairing does not install a certificate or change your phone's trust settings automatically.</p></section>}
    <h2>Paired devices</h2>{status?.devices.map((device) => <article className="card" key={device.id}><h3>{device.name}</h3><p>{device.revokedAt ? "Revoked" : device.expiresAt <= Date.now() ? "Expired" : "Paired"}</p><p>Last connected: {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "Not yet connected"}</p><button disabled={busy || !!device.revokedAt} onClick={() => void run(async () => apply(await app.request("phone_revoke", { id: device.id })))}>Revoke {device.name}</button></article>)}
    {confirming && <ConfirmDialog title="Enable encrypted phone access?" body={`Listen on ${host}:${port}. Devices need a one-time pairing code before they can access sessions. Compare the certificate fingerprint on your phone.`} action="Enable on this address" onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void configure(true); }} />}
  </div>;
}

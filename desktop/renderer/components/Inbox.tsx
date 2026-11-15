import { useEffect, useState } from "react";
import { CATEGORIES, type Category, type EmailConfig, type Frequency } from "../../../src/inbox/types.ts";
import type { InboxItem } from "../../../src/inbox/store.ts";
import { app } from "../lib/app-model.ts";
import { ConfirmDialog } from "./Dialogs.tsx";

export function Inbox({ go }: { go(route: string): void }) {
  const [category, setCategory] = useState(""), [unread, setUnread] = useState(false), [items, setItems] = useState<InboxItem[]>([]), [count, setCount] = useState(0), [error, setError] = useState(""), [more, setMore] = useState(false);
  const [before, setBefore] = useState<{ at: number; id: string }>();
  useEffect(() => {
    let current = true;
    const load = () => app.request("list_inbox", { ...(category ? { category } : {}), unread, before, limit: 100 }).then((s) => { if (current) { setItems(s.items); setCount(s.unread); setMore(s.items.length === 100); setError(""); } }).catch((e) => { if (current) setError(e.message); });
    void load(); const timer = setInterval(() => void load(), 2000); return () => { current = false; clearInterval(timer); };
  }, [category, unread, before]);
  const mark = async (item: InboxItem, read: boolean) => { try { await app.request("mark_inbox", { ids: [item.id], read }); setItems((rows) => rows.map((i) => i.id === item.id ? { ...i, read } : i).filter((i) => !unread || !i.read)); if (item.read !== read) setCount((n) => Math.max(0, n + (read ? -1 : 1))); } catch (e) { setError((e as Error).message); } };
  return <section className="page"><h2>Inbox</h2><p>{count} unread</p>{error && <p role="alert">{error}</p>}
    <label>Category<select aria-label="Inbox category" value={category} onChange={(e) => { setCategory(e.target.value); setBefore(undefined); }}><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
    <label><input type="checkbox" checked={unread} onChange={(e) => { setUnread(e.target.checked); setBefore(undefined); }} />Unread only</label>
    <button onClick={() => go("/settings/email-alerts")}>Email alerts</button>
    {!items.length && <p>No Inbox items in this view.</p>}
    <ul aria-label="Inbox items">{items.map((item) => <li key={item.id} className={item.read ? "" : "unread"}>
      <strong>{item.title}</strong> <span>{item.category}</span> <time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time>
      {item.requestId && <span>{item.resolved ? "Resolved or interrupted" : "Needs your answer"}</span>}
      <p>{item.detail}</p><button onClick={() => { void mark(item, true); go(item.route); }}>Open source</button>
      <button onClick={() => void mark(item, !item.read)}>{item.read ? "Mark unread" : "Mark read"}</button>
    </li>)}</ul>{before && <button onClick={() => setBefore(undefined)}>Newest items</button>}{more && <button onClick={() => { const last = items.at(-1); if (last) setBefore({ at: last.at, id: last.id }); }}>Load older items</button>}
  </section>;
}

export function EmailAlerts() {
  const [config, setConfig] = useState<EmailConfig>(), [status, setStatus] = useState<any>(), [error, setError] = useState(""), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let current = true; void app.request("get_email_alerts").then((s) => { if (current) { setConfig(s.config); setStatus(s); } }).catch((e) => { if (current) setError(e.message); }); return () => { current = false; }; }, []);
  useEffect(() => { let current = true; const timer = setInterval(() => void app.request("get_email_alerts").then((s) => { if (current) setStatus(s); }).catch(() => {}), 2000); return () => { current = false; clearInterval(timer); }; }, []);
  if (!config) return <section><h2>Email alerts</h2><p role={error ? "alert" : undefined}>{error || "Loading"}</p></section>;
  const field = (key: keyof EmailConfig, label: string, type = "text") => <label>{label}<input aria-label={label} type={type} value={String(config[key])} onChange={(e) => setConfig({ ...config, [key]: type === "number" ? Number(e.target.value) : e.target.value })} /></label>;
  const save = async () => { setConfirm(false); setBusy(true); try { const s = await app.request("configure_email_alerts", { config, confirmed: true }); setConfig(s.config); setStatus(s); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <section><h2>Email alerts</h2><p>Use your SMTP server. Store its password in Settings, API keys, and enter its secret name here. Alerts contain redacted summaries and source references. Review and approve tools in Rigwell.</p>
    {error && <p role="alert">{error}</p>}<fieldset disabled={busy}><legend>SMTP delivery</legend>
      <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />Enable email alerts</label>
      {field("host", "SMTP hostname")}{field("port", "SMTP port", "number")}
      <label><input type="checkbox" checked={config.secure} onChange={(e) => setConfig({ ...config, secure: e.target.checked })} />TLS immediately (usually port 465)</label><p>Otherwise STARTTLS is required. Server certificates are verified.</p>
      {field("user", "SMTP username")}{field("passwordCredential", "SMTP password secret name")}{field("from", "Sender address", "email")}{field("to", "Recipient address", "email")}{field("digestHour", "Daily digest hour (local, 0-23)", "number")}
      {CATEGORIES.map((c: Category) => <label key={c}>{c}<select aria-label={`${c} email frequency`} value={config.categories[c]} onChange={(e) => setConfig({ ...config, categories: { ...config.categories, [c]: e.target.value as Frequency } })}><option value="off">Off</option><option value="immediate">Immediately</option><option value="digest">Daily digest</option></select></label>)}
      <button onClick={() => setConfirm(true)}>Save email alerts</button></fieldset>
    {status?.error && <p role="status">Delivery uncertain: {status.error}. Check your server before sending anything again.</p>}
    {status?.deliveries?.map((d: any) => <p key={d.delivery}>{d.delivery}: {d.count}</p>)}
    {confirm && <ConfirmDialog title="Confirm email delivery" body={`Email ${config.enabled ? "enabled" : "disabled"}. SMTP: ${config.host}:${config.port}. Recipient: ${config.to}. Categories: ${CATEGORIES.map((c) => `${c}: ${config.categories[c]}`).join(", ")}. This replaces queued alerts; existing history stays in the Inbox.`} action="Save email delivery" onCancel={() => setConfirm(false)} onConfirm={() => void save()} />}
  </section>;
}

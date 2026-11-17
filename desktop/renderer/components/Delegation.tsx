import { useEffect, useState } from "react";
import type { DelegationConfig, Project } from "../../../src/delegation/store.ts";
import { app, useApp } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { ConfirmDialog } from "./Dialogs.tsx";

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const blankSlack = { enabled: false, teamId: "", users: [] as string[], appTokenCredential: "slack-app", botTokenCredential: "slack-bot" };
const blankTeams = { enabled: false, tenantId: "", appId: "", secretCredential: "teams-bot", users: [] as string[], publicUrl: "", port: 47824 };
export function DelegationPage() {
  const a = useApp();
  const [slackUsers, setSlackUsers] = useState(""), [teamsUsers, setTeamsUsers] = useState("");
  const [config, setConfig] = useState<DelegationConfig>(), [status, setStatus] = useState<any>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  useEffect(() => { let current = true; void app.request("get_delegation_status").then((s) => { if (current) { setConfig(s.config); setStatus(s); setSlackUsers(s.config.slack?.users.join(", ") ?? ""); setTeamsUsers(s.config.teams?.users.join(", ") ?? ""); } }).catch((e) => { if (current) setError(e.message); }); return () => { current = false; }; }, []);
  useEffect(() => { let current = true; const timer = setInterval(() => { void app.request("get_delegation_status").then((s) => { if (current) setStatus(s); }).catch(() => {}); }, 2000); return () => { current = false; clearInterval(timer); }; }, []);
  if (!config) return <section><h2>Slack and Teams delegation</h2>{error ? <p role="alert">{error}</p> : <p>Loading</p>}</section>;
  const slack = config.slack ?? blankSlack, teams = config.teams ?? blankTeams;
  const changeProject = (index: number, patch: Partial<Project>) => setConfig({ ...config, projects: config.projects.map((p, i) => i === index ? { ...p, ...patch } : p) });
  const save = async () => {
    setConfirm(false); setBusy(true); setError("");
    try { const s = await app.request("configure_delegation", { confirmed: true, config }); setStatus(s); setConfig(s.config); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section><h2>Slack and Teams delegation</h2><p>Allowed users can start Rigwell sessions in the projects below. Progress, questions, approvals and final answers return to their conversation. Sessions also appear in the desktop.</p>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy}><legend>Projects</legend><p>Send <code>alias: your request</code> to the app, then reply in that thread. All delegated sessions start with autonomy Off and use the normal approval gates.</p>
      {config.projects.map((p, i) => <div className="dlg-row" key={i}>
        <label>Alias<input aria-label={`Project ${i + 1} alias`} value={p.name} onChange={(e) => changeProject(i, { name: e.target.value })} /></label>
        <label>Folder<input aria-label={`Project ${i + 1} folder`} value={p.cwd} onChange={(e) => changeProject(i, { cwd: e.target.value })} /></label>
        <button onClick={() => void bridge().dialog.pickFolder().then((cwd) => { if (cwd) changeProject(i, { cwd }); })}>Choose folder</button>
        <label>Model profile<select aria-label={`Project ${i + 1} model profile`} value={p.modelId ?? ""} onChange={(e) => changeProject(i, { modelId: e.target.value || undefined })}><option value="">Configured default</option>{a.models.map((m) => <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>)}{p.modelId && !a.models.some((m) => m.id === p.modelId) && <option value={p.modelId}>{p.modelId}</option>}</select></label>
        <button onClick={() => setConfig({ ...config, projects: config.projects.filter((_, n) => n !== i) })}>Remove project</button>
      </div>)}<button onClick={() => setConfig({ ...config, projects: [...config.projects, { name: "", cwd: "" }] })}>Add project</button>
    </fieldset>
    <fieldset disabled={busy}><legend>Slack</legend><label><input type="checkbox" aria-label="Enable Slack delegation" checked={slack.enabled} onChange={(e) => setConfig({ ...config, slack: { ...slack, enabled: e.target.checked } })} />Enable Slack delegation</label>
      <p>Use the Socket Mode app from automation triggers. Store its app and bot tokens in Settings, API keys; enter their stored names here.</p>
      <label>Workspace ID<input aria-label="Slack workspace ID" value={slack.teamId} onChange={(e) => setConfig({ ...config, slack: { ...slack, teamId: e.target.value } })} /></label>
      <label>Allowed user IDs<input aria-label="Slack allowed user IDs" value={slackUsers} onChange={(e) => { setSlackUsers(e.target.value); setConfig({ ...config, slack: { ...slack, users: words(e.target.value) } }); }} /></label>
      <label>App token secret name<input aria-label="Slack app secret name" value={slack.appTokenCredential} onChange={(e) => setConfig({ ...config, slack: { ...slack, appTokenCredential: e.target.value } })} /></label>
      <label>Bot token secret name<input aria-label="Slack bot secret name" value={slack.botTokenCredential} onChange={(e) => setConfig({ ...config, slack: { ...slack, botTokenCredential: e.target.value } })} /></label>
    </fieldset>
    <fieldset disabled={busy}><legend>Teams</legend><label><input type="checkbox" aria-label="Enable Teams delegation" checked={teams.enabled} onChange={(e) => setConfig({ ...config, teams: { ...teams, enabled: e.target.checked } })} />Enable Teams delegation</label>
      <p>Register your Bot Framework bot and Teams app. Point its messaging endpoint to your own HTTPS tunnel at <code>/api/delegation/teams</code>. Forward the tunnel only to the loopback port below.</p>
      <label>Tenant ID<input aria-label="Teams tenant ID" value={teams.tenantId} onChange={(e) => setConfig({ ...config, teams: { ...teams, tenantId: e.target.value } })} /></label>
      <label>Application ID<input aria-label="Teams application ID" value={teams.appId} onChange={(e) => setConfig({ ...config, teams: { ...teams, appId: e.target.value } })} /></label>
      <label>Allowed user object IDs<input aria-label="Teams allowed user IDs" value={teamsUsers} onChange={(e) => { setTeamsUsers(e.target.value); setConfig({ ...config, teams: { ...teams, users: words(e.target.value) } }); }} /></label>
      <label>Bot secret name<input aria-label="Teams bot secret name" value={teams.secretCredential} onChange={(e) => setConfig({ ...config, teams: { ...teams, secretCredential: e.target.value } })} /></label>
      <label>Public HTTPS endpoint<input aria-label="Teams public endpoint" value={teams.publicUrl} onChange={(e) => setConfig({ ...config, teams: { ...teams, publicUrl: e.target.value } })} /></label>
      <label>Local loopback port<input aria-label="Teams local port" type="number" min={0} max={65535} value={teams.port} onChange={(e) => setConfig({ ...config, teams: { ...teams, port: Number(e.target.value) } })} /></label>
    </fieldset>
    <button disabled={busy} onClick={() => setConfirm(true)}>Save delegation settings</button>
    {confirm && <ConfirmDialog title="Confirm delegation access" body={`These users may run sessions in: ${config.projects.map((p) => `${p.name}: ${p.cwd}`).join("; ") || "no projects"}. Slack: ${slack.enabled ? slack.users.join(", ") : "off"}. Teams: ${teams.enabled ? teams.users.join(", ") : "off"}. Their conversations receive the session output and approval details. Changing these settings stops existing delegated engines.`} action="Save access" onCancel={() => setConfirm(false)} onConfirm={() => void save()} />}
    <h3>Delegated sessions</h3>{!status?.sessions?.length && <p>No delegated sessions yet.</p>}{status?.sessions?.map((s: any) => <p key={s.sessionId}><a href={`#/sessions/${s.sessionId}`}>{s.source === "slack" ? "Slack" : "Teams"}: {s.project}</a> {s.live ? "connected" : "stored"}</p>)}
    {status?.listener && <p>Teams listener: {status.listener.host}:{status.listener.port}</p>}{status?.errors?.map((e: string, i: number) => <p role="status" key={i}>{e}</p>)}
  </section>;
}

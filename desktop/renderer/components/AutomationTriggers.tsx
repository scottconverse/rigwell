import { useEffect, useState } from "react";
import { externalKind, validateEventTrigger, GITHUB_EVENTS, type ExternalKind, type EventTrigger, type GithubTrigger, type SlackTrigger, type ChainedTrigger } from "../../../src/automations/triggers/config.ts";
import { app } from "../lib/app-model.ts";
import type { AutomationRow } from "../lib/automations.ts";
import { Dialog } from "./Dialogs.tsx";

export function defaultEventTrigger(kind: ExternalKind): EventTrigger {
  return kind === "slack" ? { appTokenCredential: "slack-app", botTokenCredential: "slack-bot", events: ["mention", "dm"] } : kind === "chained" ? { automationIds: [], status: "success" } : { repos: [], events: [kind === "ci" ? "workflow_failed" : "issue_opened"], ...(kind === "ci" ? { branch: "" } : {}) };
}
const split = (value: string) => value.split(/[,\s]+/).filter(Boolean);
export function EventTriggerFields({ kind, value, onChange }: { kind: ExternalKind; value?: EventTrigger; onChange(value: EventTrigger): void }) {
  const c = value ?? defaultEventTrigger(kind), [automations, setAutomations] = useState<AutomationRow[]>([]);
  useEffect(() => { if (kind === "chained") void app.request("list_automations").then((r) => setAutomations(r.automations ?? [])).catch(() => setAutomations([])); }, [kind]);
  const set = (patch: Record<string, unknown>) => onChange({ ...c, ...patch } as EventTrigger);
  if (kind === "chained") { const chain = c as ChainedTrigger; return <fieldset><legend>Run after another automation</legend>
    {!automations.length && <p>Create a source automation first.</p>}{automations.map((a) => <label key={a.id}><input type="checkbox" checked={chain.automationIds.includes(a.id)} onChange={(e) => set({ automationIds: e.target.checked ? [...chain.automationIds, a.id] : chain.automationIds.filter((id) => id !== a.id) })} />{a.name}</label>)}
    <label>Source outcome<select aria-label="Source outcome" value={chain.status} onChange={(e) => set({ status: e.target.value })}><option value="success">Success</option><option value="failure">Final failure</option><option value="any">Either</option></select></label>
  </fieldset>; }
  if (kind === "slack") { const slack = c as SlackTrigger; return <fieldset><legend>Slack Socket Mode</legend>
    <p>Create your own Slack app and save its app-level and bot tokens in Settings &gt; API keys. Enter their stored names here.</p>
    <label>App token credential name<input aria-label="App token credential name" value={slack.appTokenCredential} onChange={(e) => set({ appTokenCredential: e.target.value })} /></label>
    <label>Bot token credential name<input aria-label="Bot token credential name" value={slack.botTokenCredential} onChange={(e) => set({ botTokenCredential: e.target.value })} /></label>
    {(["mention", "dm", "channel"] as const).map((event) => <label key={event}><input type="checkbox" checked={slack.events.includes(event)} onChange={(e) => set({ events: e.target.checked ? [...slack.events, event] : slack.events.filter((v) => v !== event) })} />{({ mention: "Mention of the app", dm: "Direct message", channel: "Channel message" })[event]}</label>)}
    <label>Channel IDs (optional for mentions and DMs)<input aria-label="Slack channel IDs" defaultValue={slack.channels?.join(", ") ?? ""} onChange={(e) => set({ channels: split(e.target.value).length ? split(e.target.value) : undefined })} /></label>
    <label>Message pattern (* and ? wildcards)<input aria-label="Slack message pattern" value={slack.pattern ?? "*"} onChange={(e) => set({ pattern: e.target.value })} /></label>
  </fieldset>; }
  const github = c as GithubTrigger;
  return <fieldset><legend>{kind === "ci" ? "GitHub CI failures" : "GitHub events"}</legend>
    <label>Repositories (owner/name)<input aria-label="GitHub repositories" defaultValue={github.repos.join(", ")} onChange={(e) => set({ repos: split(e.target.value) })} placeholder="owner/repository" /></label>
    <label>Delivery<select aria-label="GitHub event delivery" value={github.transport ?? "poll"} onChange={(e) => set({ transport: e.target.value })}><option value="poll">Poll GitHub API</option><option value="webhook">Signed webhook through your tunnel</option></select></label>
    {github.transport !== "webhook" && <label>Poll every (minutes)<input aria-label="GitHub poll minutes" type="number" min={1} max={1440} value={github.pollMinutes ?? 2} onChange={(e) => set({ pollMinutes: Number(e.target.value) })} /></label>}
    <p>Uses your Code providers connection, or an optional stored token name.</p><label>GitHub token credential name<input aria-label="GitHub token credential name" value={github.tokenCredential ?? ""} onChange={(e) => set({ tokenCredential: e.target.value || undefined })} /></label>
    {GITHUB_EVENTS.filter((event) => kind !== "ci" || ["check_failed", "workflow_failed"].includes(event)).map((event) => <label key={event}><input type="checkbox" checked={github.events.includes(event)} onChange={(e) => set({ events: e.target.checked ? [...github.events, event] : github.events.filter((v) => v !== event) })} />{event.replaceAll("_", " ")}</label>)}
    <label>Watched branch (required for CI and branch pushes)<input aria-label="Watched branch" value={github.branch ?? ""} onChange={(e) => set({ branch: e.target.value || undefined })} /></label>
    {github.events.includes("branch_pushed") && <p>Branch pushes require signed webhook delivery and one exact watched branch. Approved result posting comments on the verified pushed commit.</p>}
    <label>Mention or reviewer handle (without @)<input aria-label="GitHub handle" value={github.handle ?? ""} onChange={(e) => set({ handle: e.target.value || undefined })} /></label>
    <label>Label filter (optional)<input aria-label="GitHub label filter" value={github.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} /></label>
    {github.transport === "webhook" && <p>Rigwell shows a signing secret after creation. Configure GitHub to send the selected events to the local webhook through your own HTTPS tunnel.</p>}
  </fieldset>;
}

export function AutomationTriggerStatus({ automation, refresh }: { automation: AutomationRow; refresh(): void }) {
  const [editing, setEditing] = useState(false), [config, setConfig] = useState(automation.eventTrigger), [post, setPost] = useState(automation.postResult === true), [error, setError] = useState(""), [status, setStatus] = useState<any>();
  useEffect(() => { if (!externalKind(automation.trigger)) return; const update = () => void app.request("get_automation_trigger_status", { id: automation.id }).then((r) => setStatus(r.trigger)).catch((e) => setError(e.message)); update(); const timer = setInterval(update, 3000); return () => clearInterval(timer); }, [automation.id, automation.trigger]);
  if (!externalKind(automation.trigger)) return null;
  const save = async () => { try { validateEventTrigger(automation.trigger as ExternalKind, config); await app.request("update_automation", { id: automation.id, eventTrigger: config, postResult: post }); setEditing(false); refresh(); } catch (e) { setError((e as Error).message); } };
  return <section aria-label="Automation event trigger"><h2>Event trigger</h2><p>{automation.postResult ? "Run results can be posted back to the originating issue, PR or Slack thread." : "Results stay in Rigwell. Posting back is off."}</p>
    <button onClick={() => { setConfig(automation.eventTrigger); setPost(automation.postResult === true); setEditing(true); }}>Edit event trigger</button>
    {status?.error && <p role="alert">{status.error}</p>}{error && <p role="alert">{error}</p>}
    {status?.counts?.map((row: any) => <p key={row.state}>{row.state.replaceAll("_", " ")}: {row.count}</p>)}
    {status?.recent?.filter((row: any) => row.error).map((row: any) => <p key={row.id}>{row.error}</p>)}
    {editing && <Dialog title="Edit event trigger" onClose={() => setEditing(false)} wide><EventTriggerFields kind={automation.trigger} value={config} onChange={setConfig} /><label><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />Allow posting run results back to the source</label><button onClick={() => setEditing(false)}>Cancel</button><button onClick={() => void save()}>Save event trigger</button></Dialog>}
  </section>;
}

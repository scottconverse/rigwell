import { createHash } from "node:crypto";
import { configuredSecretValues, redactSharedText } from "../sharing/redact.ts";
import { rigwellHome } from "../storage/paths.ts";
import { secretValue } from "../secrets/store.ts";
import { InboxStore, defaultEmail, validateEmail, type Category, type EmailConfig } from "./store.ts";
import { sendSmtp, type AlertMessage } from "./mail.ts";

export interface InboxDeps { now?: () => number; send?: (config: EmailConfig, message: AlertMessage, signal: AbortSignal) => Promise<void> }
export class InboxService {
  private config: EmailConfig; private timer?: ReturnType<typeof setInterval>; private job?: Promise<void>; private controller?: AbortController; private stopped = false; private changing = false; private error?: string;
  private now: () => number;
  constructor(readonly store = new InboxStore(), private deps: InboxDeps = {}, private changed?: () => void, private log?: (s: string) => void) {
    this.now = deps.now ?? Date.now;
    try { this.config = store.config(); } catch { this.config = defaultEmail(); this.error = "Email configuration could not be loaded; delivery is disabled"; this.log?.(`[inbox] ${this.error}`); }
  }
  private redact(text: string, cwd = rigwellHome()) { const password = secretValue(this.config.passwordCredential); return redactSharedText(text, [...configuredSecretValues(cwd), ...(password ? [password] : [])]); }
  start() { this.store.recover(); this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref?.(); }
  private add(category: Category, id: string, title: string, detail: string, route: string, sessionId?: string, requestId?: string, cwd?: string, resolved = true) {
    try {
      const at = this.now(), mode = this.config.enabled && !this.changing ? this.config.categories[category] : "off";
      const daily = new Date(at); daily.setHours(this.config.digestHour, 0, 0, 0); if (daily.getTime() <= at) daily.setDate(daily.getDate() + 1);
      const values = configuredSecretValues(cwd ?? rigwellHome());
      const password = secretValue(this.config.passwordCredential); if (password) values.push(password);
      if (this.store.add({ id, category, at, title: redactSharedText(title, values).replace(/[\r\n]+/g, " ").slice(0, 200), detail: redactSharedText(detail, values).slice(0, 1500), route, sessionId, requestId, read: false, resolved }, mode, mode === "digest" ? daily.getTime() : at)) this.changed?.();
    } catch (e) { this.log?.(`[inbox] event could not be stored: ${this.redact((e as Error).message)}`); }
  }
  session(session: { id: string; cwd?: string } | undefined, n: any, route?: string) {
    try { this.captureSession(session, n, route); } catch (e) { this.log?.(`[inbox] event could not be stored: ${this.redact((e as Error).message)}`); }
  }
  private captureSession(session: { id: string; cwd?: string } | undefined, n: any, route?: string) {
    if (!session || !n) return;
    const source = route ?? `/sessions/${encodeURIComponent(session.id)}`;
    if (n.type === "user_prompt_requested") this.add(n.kind === "permission" ? "permission" : "question", `prompt:${session.id}:${n.requestId}`, n.kind === "permission" ? "Permission required" : "Agent question", n.summary ?? "Open the source to review and answer.", source, session.id, n.requestId, session.cwd, false);
    else if (["permission_resolved", "ask_user_resolved"].includes(n.type)) { this.store.resolve(session.id, n.requestId); this.changed?.(); }
    else if (n.type === "agent_turn_completed") { this.store.resolve(session.id); this.add("turn", `turn:${session.id}:${n.turnId}`, `Turn ${n.reason ?? "completed"}`, "Open the session for its answer and transcript.", source, session.id, undefined, session.cwd); }
  }
  mission(session: { id: string; cwd?: string } | undefined, n: any) {
    if (!session || !n || !["mission_state_changed", "mission_worker_completed", "mission_progress_entry"].includes(n.type)) return;
    const entry = n.progressLog;
    const identity = entry ? createHash("sha256").update(JSON.stringify(entry)).digest("hex") : n.updatedAt ?? crypto.randomUUID();
    this.add("mission", `mission:${session.id}:${n.type}:${identity}:${n.workerSessionId ?? n.state ?? ""}`, n.type === "mission_state_changed" ? `Mission ${n.state}` : n.type === "mission_worker_completed" ? "Mission worker finished" : `Mission ${entry?.type ?? "progress"}`, "Open Mission Control for details.", `/missions/${encodeURIComponent(session.id)}`, session.id, undefined, session.cwd);
  }
  workstream(n: any, cwd?: string) {
    const route = `/workstreams/${encodeURIComponent(n.workstreamId)}`;
    if (n.type === "workstream_member_notification") { this.session({ id: n.sessionId, cwd }, n.notification, route); return; }
    if (n.type === "workstream_prompt_resolved") return;
    if (!["workstream_updated", "workstream_agent_status", "workstream_message", "workstream_listener_fired", "workstream_budget_reached"].includes(n.type)) return;
    // Message reads and heartbeat-like working updates do not need a user notification.
    if (n.type === "workstream_message" && (n.message?.readAt || n.message?.to !== "lead" && n.message?.to !== "user")) return;
    const identity = n.message?.id ?? n.agent?.lastActivityAt ?? n.workstream?.updatedAt ?? crypto.randomUUID();
    this.add("workstream", `workstream:${n.workstreamId}:${n.type}:${n.agent?.agentId ?? ""}:${n.agent?.status ?? n.workstream?.state ?? ""}:${identity}`, n.type === "workstream_agent_status" ? `Member ${n.agent?.name}: ${n.agent?.status}` : n.type === "workstream_updated" ? `Workstream ${n.workstream?.state}` : n.type === "workstream_message" ? "Workstream message" : n.type === "workstream_budget_reached" ? "Workstream budget reached" : "Workstream listener fired", "Open the Workstream for details.", route, undefined, undefined, cwd);
  }
  automation(a: any, run: any) { this.add("automation", `automation:${a.id}:${run.runId}`, `Automation ${a.fm.name}: ${run.status}`, "Open the automation run history for details.", `/automations/${encodeURIComponent(a.id)}`, run.sessionId, undefined, a.fm.workingDirectory); }
  readonly methods = {
    list_inbox: (p: Record<string, unknown>) => this.store.list(p),
    mark_inbox: (p: Record<string, unknown>) => { if (!Array.isArray(p.ids) || p.ids.length > 200 || p.ids.some((id) => typeof id !== "string" || id.length > 512) || typeof p.read !== "boolean") throw new Error("Choose up to two hundred Inbox items and their read state"); this.store.mark(p.ids, p.read); this.changed?.(); return {}; },
    get_email_alerts: () => ({ config: this.config, deliveries: this.store.deliveries(), error: this.error }),
    configure_email_alerts: async (p: Record<string, unknown>) => {
      if (p.confirmed !== true) throw new Error("Confirm the SMTP server, recipient and alert categories");
      const config = validateEmail(p.config); if (this.changing) throw new Error("Email settings are already changing");
      this.changing = true;
      try { await this.job; this.store.save(config); this.store.cancelQueued(); this.config = config; this.error = undefined; return this.methods.get_email_alerts(); }
      finally { this.changing = false; }
    },
  };
  flush(): Promise<void> {
    if (this.job) return this.job;
    if (this.stopped || this.changing || !this.config.enabled) return Promise.resolve();
    this.job = this.deliver().finally(() => { this.job = undefined; }); return this.job;
  }
  private async deliver() {
    const due = this.store.due(this.now()); if (!due.length) return;
    const groups = [...due.filter((i) => i.mode === "immediate").map((i) => [i]), due.filter((i) => i.mode === "digest")].filter((g) => g.length);
    for (const group of groups) {
      if (this.stopped || this.changing) return;
      const ids = group.map((i) => i.id), id = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
      this.store.delivery(ids, "sending"); this.controller = new AbortController();
      try {
        const text = group.map((i) => `${new Date(i.at).toISOString()} [${i.category}] ${i.title}\n${i.detail}\nrigwell:/${i.route}`).join("\n\n");
        await (this.deps.send ?? sendSmtp)(this.config, { subject: group[0]!.mode === "digest" ? `Rigwell daily digest (${group.length})` : `Rigwell: ${group[0]!.title}`, text: this.redact(text), id }, this.controller.signal);
        this.store.delivery(ids, "sent"); this.error = undefined;
      } catch (e) { this.store.delivery(ids, "uncertain"); this.error = this.redact((e as Error).message).slice(0, 500); this.log?.(`[inbox] Email delivery uncertain: ${this.error}`); }
      finally { this.controller = undefined; this.changed?.(); }
    }
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); await this.job; }
}

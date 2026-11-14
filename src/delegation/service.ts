import { randomBytes } from "node:crypto";
import { RpcClient } from "../sdk/client.ts";
import type { Transport } from "../sdk/transport.ts";
import { SlackHub, type SlackHandle } from "../automations/triggers/slack.ts";
import type { SlackTrigger } from "../automations/triggers/config.ts";
import { configuredSecretValues, redactSharedText } from "../sharing/redact.ts";
import { secretValue } from "../secrets/store.ts";
import { rigwellHome } from "../storage/paths.ts";
import { DelegationStore, sourceKey, validateDelegation, type Binding, type DelegationConfig, type Event, type Source } from "./store.ts";
import { TeamsConnector, type TeamsDeps } from "./teams.ts";

export interface DelegationConnection { feed(line: string): void; close(): Promise<void> | void }
export interface DelegationDeps { slackHub?: SlackHub; teams?: TeamsDeps }
interface Runtime { binding: Binding; client: RpcClient; text: string; messageId?: string; timer?: ReturnType<typeof setTimeout>; output: Promise<void>; tools: Set<string> }
interface Prompt { runtime: Runtime; method: string; params: any; resolve(answer: unknown): void; timer: ReturnType<typeof setTimeout>; tokens: Set<string>; question: number; answers: any[]; selected: Set<string> }
interface Action { prompt: Prompt; answer: any }
export class DelegationService {
  private config: DelegationConfig = { projects: [] }; private slack?: SlackHandle; private teams?: TeamsConnector;
  private server?: ReturnType<typeof Bun.serve>; private timer?: ReturnType<typeof setInterval>; private stopped = false;
  private runtimes = new Map<string, Runtime>(); private opening = new Map<string, Promise<Runtime>>(); private busy = new Set<string>(); private jobs = new Set<Promise<void>>();
  private prompts = new Set<Prompt>(); private actions = new Map<string, Action>(); private errors: string[] = [];
  private hub: SlackHub;
  private reconfiguring = false;
  constructor(readonly store: DelegationStore, private open: (write: (line: string) => void) => DelegationConnection, private deps: DelegationDeps = {}, private log?: (s: string) => void) { this.hub = deps.slackHub ?? new SlackHub(); }
  private error(e: unknown) { const message = redactSharedText((e as Error).message ?? "Delegation failed", this.secrets()).slice(0, 1000); this.errors = [...this.errors.slice(-9), message]; this.log?.(`[delegation] ${message}`); return message; }
  private secrets(cwd?: string) {
    return [...configuredSecretValues(cwd ?? rigwellHome()), ...[this.config.slack?.appTokenCredential, this.config.slack?.botTokenCredential, this.config.teams?.secretCredential].filter((s): s is string => !!s).map((s) => secretValue(s)).filter((s): s is string => !!s)];
  }
  private allowed(s: Source) {
    if (this.reconfiguring) return false;
    return s.service === "slack" ? this.config.slack?.enabled && this.config.slack.teamId === s.workspace && this.config.slack.users.includes(s.user) : this.config.teams?.enabled && this.config.teams.tenantId === s.workspace && this.config.teams.users.includes(s.user);
  }
  status() { const status = this.store.status(); return { config: this.config, listener: this.server ? { host: "127.0.0.1", port: this.server.port } : undefined, sessions: this.store.bindings().map((b) => ({ sessionId: b.sessionId, cwd: b.cwd, project: b.project, source: b.source.service, user: b.source.user, live: this.runtimes.has(b.key) })), counts: status.counts, errors: [...(status.errors as { error: string }[]).map((r) => r.error), ...this.errors] }; }
  readonly methods = {
    get_delegation_status: async () => this.status(),
    configure_delegation: async (p: Record<string, unknown>) => {
      if (p.confirmed !== true) throw new Error("Confirm the project folders and users that may delegate work");
      const config = validateDelegation(p.config);
      try { await this.apply(config); this.store.save(config); }
      catch (e) {
        const disabled = { ...config, ...(config.slack ? { slack: { ...config.slack, enabled: false } } : {}), ...(config.teams ? { teams: { ...config.teams, enabled: false } } : {}) };
        await this.apply(disabled); this.store.save(disabled); this.error(e); throw e;
      }
      return this.status();
    },
  };
  async start() {
    this.stopped = false; this.store.recover();
    try { await this.apply(this.store.config()); }
    catch (e) { this.error(e); await this.apply({ ...this.config, ...(this.config.slack ? { slack: { ...this.config.slack, enabled: false } } : {}), ...(this.config.teams ? { teams: { ...this.config.teams, enabled: false } } : {}) }); }
    this.timer = setInterval(() => this.tick(), 200); this.timer.unref?.();
  }
  private async apply(config: DelegationConfig) {
    if (this.reconfiguring) throw new Error("Delegation configuration is already changing");
    this.reconfiguring = true;
    try {
    // Finish old approval requests and engines before changing their authority or destination.
    await this.closeRuntimes(); this.slack?.stop(); this.slack = undefined; this.server?.stop(true); this.server = undefined; this.teams?.stop(); this.teams = undefined; this.config = config;
    if (config.slack?.enabled) {
      const s = config.slack, trigger: SlackTrigger = { appTokenCredential: s.appTokenCredential, botTokenCredential: s.botTokenCredential, events: ["mention", "dm"] };
      this.slack = this.hub.acquire(trigger, (p) => this.slackPayload(p), (m) => this.error(new Error(m)));
    }
    if (config.teams?.enabled) {
      this.teams = new TeamsConnector(config.teams, this.deps.teams);
      try { this.server = Bun.serve({ hostname: "127.0.0.1", port: config.teams.port, fetch: (r) => this.teamsRequest(r) }); }
      catch (e) { this.teams.stop(); this.teams = undefined; throw e; }
    }
    } finally { this.reconfiguring = false; }
  }
  private ingest(event: Event) {
    if (this.stopped || !this.allowed(event.source) || !Number.isFinite(event.at) || Math.abs(Date.now() - event.at) > 24 * 60 * 60_000) return;
    const pending = [...this.prompts].filter((p) => sourceKey(p.runtime.binding.source) === sourceKey(event.source) && p.method === "ask_user");
    if (pending.length && event.text.trim() !== "/stop") {
      // Persist the event ID first so a provider retry cannot answer a later question.
      if (this.store.enqueue(event)) {
        const addressed = /^answer\s+(\S+):\s*([\s\S]+)$/i.exec(event.text);
        const prompt = addressed ? pending.find((p) => p.params.requestId === addressed[1]) : pending.length === 1 ? pending[0] : undefined;
        this.store.state(event.id, prompt ? "answered" : "filtered");
        if (prompt) this.questionAnswer(prompt, addressed?.[2] ?? event.text);
        else this.output(pending[0]!.runtime, "Several questions are pending, or that question is no longer available. Use its buttons or reply: answer <requestId>: your answer");
      } return;
    }
    this.store.enqueue(event);
  }
  private slackPayload(payload: any) {
    if (this.stopped || !this.config.slack?.enabled) return;
    if (payload?.type === "block_actions") {
      const source: Source = { service: "slack", workspace: payload.team?.id, user: payload.user?.id, conversation: payload.channel?.id, thread: payload.message?.thread_ts ?? payload.container?.message_ts };
      for (const action of payload.actions ?? []) if (typeof action.value === "string") this.answer(action.value, source);
      return;
    }
    const e = payload?.event;
    if (!e || e.bot_id || e.subtype || !["app_mention", "message"].includes(e.type) || (e.type === "message" && e.channel_type !== "im" && !e.thread_ts) || typeof e.text !== "string" || typeof payload.event_id !== "string" || !/^[CDG][A-Z0-9]+$/.test(e.channel ?? "") || !/^\d+\.\d+$/.test(e.thread_ts ?? e.ts ?? "")) return;
    const source: Source = { service: "slack", workspace: payload.team_id, user: e.user, conversation: e.channel, thread: e.thread_ts ?? e.ts };
    // Replies in a public thread only reach an already-owned delegated session.
    if (e.type === "message" && e.channel_type !== "im" && !this.store.bindings().some((b) => b.key === sourceKey(source))) return;
    this.ingest({ id: `slack:${payload.team_id}:${payload.event_id}`, at: Number(e.event_ts ?? e.ts) * 1000, source, text: e.text.replace(/<@[A-Z0-9]+>/g, "").trim() });
  }
  private async teamsRequest(req: Request): Promise<Response> {
    if (!this.config.teams?.enabled || !this.teams || req.method !== "POST" || new URL(req.url).pathname !== "/api/delegation/teams") return new Response("Not found", { status: 404 });
    const host = req.headers.get("host"); if (host !== new URL(this.config.teams.publicUrl).host && host !== `127.0.0.1:${this.server?.port}` && host !== `localhost:${this.server?.port}`) return new Response("Invalid host", { status: 403 });
    try {
      const reader = req.body?.getReader(); if (!reader) return new Response("Missing body", { status: 400 });
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const c = await reader.read(); if (c.done) break; size += c.value.length; if (size > 256 * 1024) return new Response("Body too large", { status: 413 }); chunks.push(c.value); } } finally { await reader.cancel().catch(() => {}); }
      const activity = JSON.parse(Buffer.concat(chunks).toString()), source = await this.teams.authenticate(req.headers.get("authorization"), activity);
      if (activity.type === "invoke" && activity.name === "adaptiveCard/action" && activity.value?.action?.verb === "rigwell.answer") {
        const accepted = this.answer(activity.value.action.data?.token, source);
        return Response.json({ statusCode: accepted ? 200 : 403, type: "application/vnd.microsoft.activity.message", value: accepted ? "Answer received" : "This request is no longer available" });
      }
      if (activity.type === "message" && typeof activity.text === "string") this.ingest({ id: `teams:${source.workspace}:${source.conversation}:${activity.id}`, source, at: Date.parse(activity.timestamp), text: activity.text.replace(/<at>[^<]*<\/at>/g, "").trim() });
      return new Response(null, { status: 200 });
    } catch { return new Response("Invalid or unauthorized Teams activity", { status: 403 }); }
  }
  tick() {
    if (this.stopped || this.reconfiguring || (!this.config.slack?.enabled && !this.config.teams?.enabled)) return;
    for (const event of this.store.queued()) {
      const key = sourceKey(event.source); if (this.busy.has(key) || this.jobs.size >= 16) continue;
      this.store.state(event.id, "admitted"); this.busy.add(key);
      const job = this.dispatch(event).then((state) => this.store.state(event.id, state ?? "dispatched"), async (e) => { const error = this.error(e); this.store.state(event.id, "failed", error); await this.send(event.source, `Delegation failed: ${error}`).catch((sendError) => { this.error(sendError); }); }).finally(() => { this.busy.delete(key); this.jobs.delete(job); }); this.jobs.add(job);
    }
  }
  private async dispatch(event: Event) {
    if (!this.allowed(event.source) || this.stopped) return "ignored";
    const key = sourceKey(event.source), binding = this.store.bindings().find((b) => b.key === key);
    let text = event.text, project = binding ? this.config.projects.find((p) => p.name === binding.project && p.cwd === binding.cwd) : undefined;
    if (!binding) {
      const match = /^([a-z][a-z0-9_-]{0,31}):\s*([\s\S]+)$/.exec(text);
      project = this.config.projects.find((p) => p.name === match?.[1]); text = match?.[2] ?? "";
      if (!project || !text.trim()) { await this.send(event.source, `Choose a project: ${this.config.projects.map((p) => p.name + ": your request").join("; ")}`); return; }
    }
    if (!project) throw new Error("The delegated project is no longer configured");
    if (text.trim() === "/stop") { const rt = this.runtimes.get(key); if (rt) await rt.client.request("interrupt_session", { clearQueued: true }); return; }
    const runtime = await this.runtime(event.source, project, binding);
    if (!this.allowed(event.source) || this.stopped) return;
    await runtime.client.request("add_user_message", { text, messageId: `delegation:${event.id}`, userMessageSource: event.source.service });
  }
  private async runtime(source: Source, project: DelegationConfig["projects"][number], saved?: Binding): Promise<Runtime> {
    const key = sourceKey(source), existing = this.runtimes.get(key); if (existing) return existing;
    if (this.opening.has(key)) return this.opening.get(key)!;
    if (this.runtimes.size + this.opening.size >= 16) throw new Error("Close or disable an existing delegated session before starting another (limit sixteen)");
    const promise = (async () => {
      let connection!: DelegationConnection;
      const transport: Transport = { onMessage: () => {}, onClose: () => {}, write: (line) => connection.feed(line), close: async () => { await connection.close(); transport.onClose(); } };
      const client = new RpcClient(transport); connection = this.open((line) => transport.onMessage(line.trim()));
      const binding: Binding = saved ?? { key, source, project: project.name, cwd: project.cwd, sessionId: crypto.randomUUID() };
      const rt: Runtime = { binding, client, text: "", output: Promise.resolve(), tools: new Set() };
      client.onRequest = (method, params) => this.prompt(rt, method, params);
      client.onNotification = (method, p) => { if (method === "session_notification") this.notification(rt, p.notification); };
      try {
        if (saved) await client.request("load_session", { sessionId: saved.sessionId, cwd: project.cwd });
        else await client.request("initialize_session", { sessionId: binding.sessionId, cwd: project.cwd, title: `[${source.service === "slack" ? "Slack" : "Teams"}] ${project.name}`, autonomyLevel: "off", ...(project.modelId ? { modelId: project.modelId } : {}), tags: [{ name: `delegation-${source.service}`, metadata: { workspace: source.workspace, user: source.user, conversation: source.conversation } }] });
        if (this.stopped || !this.allowed(source)) throw new Error("Delegation was disabled");
        this.store.bind(binding); this.runtimes.set(key, rt); await this.send(source, `Connected to ${project.name}. Session ${binding.sessionId}. Reply in this thread to continue; /stop interrupts.`); return rt;
      } catch (e) { await client.close(); throw e; }
    })().finally(() => this.opening.delete(key));
    this.opening.set(key, promise); return promise;
  }
  private send(source: Source, text: string, choices?: { label: string; value: string }[], cwd?: string) {
    if (this.stopped || !this.allowed(source)) return Promise.resolve();
    const secrets = this.secrets(cwd); text = redactSharedText(text, secrets).slice(0, 3800);
    choices = choices?.map((c) => ({ ...c, label: redactSharedText(c.label, secrets) }));
    if (source.service === "teams") return this.teams!.send(source, text, choices).then(() => {});
    const blocks = choices?.length ? [{ type: "section", text: { type: "plain_text", text: text.slice(0, 2800) } }, ...Array.from({ length: Math.ceil(choices.length / 5) }, (_, i) => ({ type: "actions", elements: choices.slice(i * 5, i * 5 + 5).map((c) => ({ type: "button", text: { type: "plain_text", text: c.label.slice(0, 70) }, action_id: c.value, value: c.value })) }))] : undefined;
    return this.slack!.api("chat.postMessage", { channel: source.conversation, thread_ts: source.thread, text, mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(blocks ? { blocks } : {}) }).then(() => {});
  }
  private output(rt: Runtime, text: string, choices?: { label: string; value: string }[]) {
    if (text.length > 3500) text = `${text.slice(0, 3300)}\n[Clipped. Full transcript in Rigwell session ${rt.binding.sessionId}.]`;
    rt.output = rt.output.then(() => this.send(rt.binding.source, text, choices, rt.binding.cwd)).catch((e) => { this.error(e); });
  }
  private notification(rt: Runtime, n: any) {
    if (!n || this.stopped) return;
    if (n.type === "workstream_member_notification") {
      this.resolvePrompts(rt, n.notification, n.agentId); return;
    }
    if (n.type === "workstream_prompt_resolved") {
      this.resolvePrompts(rt, { type: "ask_user_resolved", requestId: n.requestId }, n.agentId); return;
    }
    if (n.type === "assistant_text_delta") {
      if (rt.messageId !== n.messageId) { rt.messageId = n.messageId; rt.text = ""; }
      rt.text = (rt.text + String(n.textDelta ?? "")).slice(-60_000);
      if (!rt.timer) rt.timer = setTimeout(() => { rt.timer = undefined; if (rt.text) this.output(rt, `Progress\n${rt.text.slice(-3000)}`); }, 2000);
    } else if (n.type === "agent_turn_completed") {
      clearTimeout(rt.timer); rt.timer = undefined; this.output(rt, `Finished (${n.reason ?? "completed"})\n${rt.text || "Turn ended without a text answer. Open the session in Rigwell for its transcript."}`); rt.text = "";
    } else if (n.type === "tool_call" && n.toolUse?.name && !rt.tools.has(n.toolUse.id)) { rt.tools.add(n.toolUse.id); if (rt.tools.size > 1000) rt.tools.delete(rt.tools.values().next().value!); this.output(rt, `Running ${n.toolUse.name}`); }
    else if (n.type === "error") this.output(rt, `Session error: ${String(n.message ?? n.error ?? "See Rigwell")}`);
    this.resolvePrompts(rt, n);
  }
  private resolvePrompts(rt: Runtime, n: any, agentId?: string) {
    if (!n || !["agent_turn_completed", "permission_resolved", "ask_user_resolved"].includes(n.type)) return;
    for (const p of [...this.prompts]) if (p.runtime === rt && p.params.agentId === agentId && (n.type === "agent_turn_completed" || p.params.requestId === n.requestId)) this.finishPrompt(p, p.method === "ask_user" ? { cancelled: true, answers: [] } : { selectedOption: "cancel" });
  }
  private token(p: Prompt, answer: any) { const token = randomBytes(24).toString("base64url"); this.actions.set(token, { prompt: p, answer }); p.tokens.add(token); return token; }
  private prompt(rt: Runtime, method: string, params: any): Promise<unknown> {
    if (this.stopped || !this.allowed(rt.binding.source)) return Promise.resolve(method === "ask_user" ? { cancelled: true, answers: [] } : method === "request_trust" ? { trust: false } : { selectedOption: "cancel" });
    if (!["ask_user", "request_permission", "request_trust"].includes(method)) return Promise.reject(new Error("Unsupported delegated request"));
    return new Promise((resolve) => {
      const p: Prompt = { runtime: rt, method, params, resolve, timer: undefined as any, tokens: new Set(), question: 0, answers: [], selected: new Set() };
      p.timer = setTimeout(() => this.finishPrompt(p, method === "ask_user" ? { cancelled: true, answers: [] } : method === "request_trust" ? { trust: false } : { selectedOption: "cancel" }), 30 * 60_000); p.timer.unref?.(); this.prompts.add(p);
      if (method === "ask_user") this.showQuestion(p);
      else {
        const details = redactSharedText(JSON.stringify(params, null, 2), this.secrets(rt.binding.cwd));
        if (method === "request_permission" && details.length > 2600) {
          this.output(rt, `Permission details exceed the chat preview. Review and answer the complete request in ${params.agentId ? `Rigwell Workstream ${params.workstreamId}, member ${params.agentName ?? params.agentId}` : `Rigwell session ${rt.binding.sessionId}`}.`, [{ label: "Cancel", value: this.token(p, { selectedOption: "cancel" }) }]); return;
        }
        const options = method === "request_trust" ? [{ label: "Trust for this session", value: "trust" }, { label: "Continue untrusted", value: "untrusted" }] : params.options ?? [{ label: "Allow once", value: "proceed_once" }, { label: "Deny", value: "cancel" }];
        this.output(rt, `${method === "request_trust" ? "Trust project settings?" : "Permission required"}\n${details}`, options.slice(0, 20).map((o: any) => ({ label: String(o.label), value: this.token(p, method === "request_trust" ? { trust: o.value === "trust", remember: false } : { selectedOption: o.value }) })));
      }
    });
  }
  private clearTokens(p: Prompt) { for (const token of p.tokens) this.actions.delete(token); p.tokens.clear(); }
  private showQuestion(p: Prompt) {
    this.clearTokens(p); const q = p.params.questions?.[p.question];
    if (!q) { this.finishPrompt(p, { answers: p.answers }); return; }
    const choices = (q.options ?? []).slice(0, 18).map((o: string) => ({ label: `${p.selected.has(o) ? "[x] " : ""}${o}`, value: this.token(p, { option: o }) }));
    if (q.multiSelect) choices.push({ label: "Submit selections", value: this.token(p, { submit: true }) });
    choices.push({ label: "Cancel question", value: this.token(p, { cancel: true }) });
    this.output(p.runtime, `${p.params.agentId ? `Member ${p.params.agentName ?? p.params.agentId}\n` : ""}${q.question}\n${q.multiSelect ? "Select choices, then Submit selections. " : ""}You may also reply in this thread with a text answer. With several pending questions, use: answer ${p.params.requestId}: your answer`, choices);
  }
  private questionAnswer(p: Prompt, answer: string) { const q = p.params.questions?.[p.question]; if (!q) return; p.answers.push({ index: q.index, question: q.question, answer }); p.question++; p.selected.clear(); this.showQuestion(p); }
  private answer(token: unknown, source: Source) {
    if (typeof token !== "string" || !this.allowed(source)) return false;
    const action = this.actions.get(token); if (!action) return false;
    const { prompt: p, answer } = action, owner = p.runtime.binding.source;
    if (owner.service !== source.service || owner.workspace !== source.workspace || owner.user !== source.user || owner.conversation !== source.conversation || (source.service === "slack" && owner.thread !== source.thread)) return false;
    this.clearTokens(p);
    if (p.method !== "ask_user") this.finishPrompt(p, answer);
    else if (answer.cancel) this.finishPrompt(p, { cancelled: true, answers: [] });
    else if (answer.submit) this.questionAnswer(p, [...p.selected].join(", "));
    else if (p.params.questions[p.question]?.multiSelect) { p.selected.has(answer.option) ? p.selected.delete(answer.option) : p.selected.add(answer.option); this.showQuestion(p); }
    else this.questionAnswer(p, answer.option);
    return true;
  }
  private finishPrompt(p: Prompt, answer: unknown) { if (!this.prompts.delete(p)) return; clearTimeout(p.timer); this.clearTokens(p); p.resolve(answer); }
  private async closeRuntimes() {
    for (const p of [...this.prompts]) this.finishPrompt(p, p.method === "ask_user" ? { cancelled: true, answers: [] } : p.method === "request_trust" ? { trust: false } : { selectedOption: "cancel" });
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.runtimes.values()].map(async (rt) => { clearTimeout(rt.timer); await rt.client.close(); await rt.output; })); this.runtimes.clear();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.slack?.stop(); this.teams?.stop(); this.server?.stop(true); await this.closeRuntimes(); await Promise.allSettled(this.jobs); }
}

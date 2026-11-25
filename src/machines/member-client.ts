import type { MemberHost, MemberLimits, MemberView } from "../workstreams/member.ts";
import type { AutonomyLevel, TokenUsage } from "../core/types.ts";
import type { ConnectionOptions } from "../daemon/connection.ts";
import type { RpcClient } from "../sdk/client.ts";
import { RemoteSessionStore } from "./sessions.ts";
import { SharedNotes } from "./shared-notes.ts";
import { recordSharedPath } from "../workstreams/shared-history.ts";

export class RemoteMemberClient {
  private client?: RpcClient;
  private opening?: Promise<RpcClient>;
  private closed = false;
  private admissions = new Map<string, { abort: AbortController; release?: () => void }>();
  private snapshot?: { cwd: string; settings: MemberView["settings"]; isAgentLoopInProgress: boolean; messages: ReturnType<MemberView["uiMessages"]>; queuedMessages?: ReturnType<MemberView["queuedMessages"]> };
  private notifications = Promise.resolve();
  private prompts = new Map<string, { kind: "permission" | "ask_user"; requestId: string; params: Record<string, unknown>; answer(v: unknown): void }>();
  private resolveClosed!: () => void;
  private closedSignal = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  private watches = new Map<string, (event: Record<string, unknown>) => void>();
  readonly view: MemberView;
  constructor(private host: MemberHost, private remote: { machine: string; sessionId: string; name?: string; sharedPath?: string; connectMachine?: ConnectionOptions["connectMachine"] }, private maxAutonomy: AutonomyLevel, private limits: MemberLimits, private log?: (m: string) => void) {
    const self = this;
    this.view = {
      id: remote.sessionId,
      get cwd() { return self.snapshot?.cwd ?? "."; },
      get settings() { return self.snapshot?.settings ?? { autonomyLevel: maxAutonomy, modelId: "", reasoningEffort: "off", interactionMode: "auto" }; },
      get isRunning() { return self.snapshot?.isAgentLoopInProgress === true; },
      uiMessages: () => self.snapshot?.messages ?? [],
      queuedMessages: () => self.snapshot?.queuedMessages ?? [],
      pendingPrompts: () => [...self.prompts.values()],
      async addUserMessage(text, messageId, userMessageSource, options) { await self.call("owned_member_message", { text, messageId, userMessageSource, placement: options?.placement }); },
      interrupt(discard) { void self.call("interrupt_session", { discardQueuedMessages: discard }).catch((e) => log?.(`[remote member] interrupt: ${e.message}`)); },
    };
  }
  private async connect(): Promise<RpcClient> {
    if (this.closed) throw new Error("Remote member closed");
    if (this.opening) return this.opening;
    if (this.client) return this.client;
    return this.opening ??= (async () => {
      const client = await (this.remote.connectMachine ?? (async (name) => (await import("./bootstrap.ts")).connectMachine(name, { log: this.log })))(this.remote.machine);
      if (this.closed) { await client.close(); throw new Error("Remote member closed during SSH startup"); }
      this.client = client;
      const notes = this.remote.sharedPath ? new SharedNotes(this.remote.sharedPath, this.remote.sessionId, this.limits.maxToolIds, (absPath) => {
        try { recordSharedPath(this.remote.sharedPath!, absPath, this.remote.name ?? "remote member"); }
        catch (e) { this.log?.(`[remote member] shared history: ${(e as Error).message}`); }
      }) : undefined;
      client.onClose = () => {
        const unexpected = !this.closed;
        this.closed = true; this.resolveClosed(); this.releaseAll();
        if (unexpected && this.snapshot) {
          this.snapshot.isAgentLoopInProgress = false;
          this.host.notify({ type: "session_process_exited", message: "Remote member SSH channel closed" });
          this.host.notify({ type: "agent_turn_completed", reason: "error" });
        }
      };
      client.onRequest = async (method, p) => {
        if (method === "owned_member_shared_file") {
          if (!notes) throw new Error("No approved shared folder");
          return notes.run(p.name, p.input);
        }
        if (method === "owned_member_admit") {
          if (typeof p.id !== "string" || this.admissions.has(p.id)) throw new Error("Invalid admission lease");
          const lease = { abort: new AbortController(), release: undefined as (() => void) | undefined };
          this.admissions.set(p.id, lease);
          try {
            lease.release = await this.limits.beforeTurn?.(lease.abort.signal) ?? (() => {});
            if (lease.abort.signal.aborted || this.closed) { lease.release(); throw new Error("Member admission cancelled"); }
            return { allowedModels: this.limits.allowedModelIds?.() };
          } catch (e) { this.admissions.delete(p.id); throw e; }
        }
        if (method === "owned_member_usage") {
          const usage = p.usage as TokenUsage;
          if (typeof p.modelId !== "string" || !usage || ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "thinkingTokens"].some((key) => !Number.isFinite(usage[key as keyof TokenUsage]) || usage[key as keyof TokenUsage] < 0)) throw new Error("Invalid member usage");
          await this.limits.onUsage?.(p.modelId, usage); return {};
        }
        if (method === "owned_member_tool") {
          const tool = this.host.tools([]).find((t) => t.name === p.name);
          if (!tool || !p.input || typeof p.input !== "object" || Array.isArray(p.input)) throw new Error("Member control tool is unavailable");
          return tool.run(p.input as Record<string, unknown>, { sessionId: this.remote.sessionId, cwd: this.view.cwd, signal: new AbortController().signal, readFiles: new Map() });
        }
        let answer!: (v: unknown) => void;
        const answered = new Promise<unknown>((resolve) => { answer = resolve; });
        const id = typeof p.requestId === "string" ? p.requestId : undefined;
        if (id && ["request_permission", "ask_user"].includes(method)) this.prompts.set(id, { kind: method === "request_permission" ? "permission" : "ask_user", requestId: id, params: p, answer });
        try { return await Promise.race([this.host.request(method, p), answered, this.closedSignal.then(() => ({ selectedOption: "cancel", cancelled: true, answers: [], trust: false }))]); }
        finally { if (id) this.prompts.delete(id); }
      };
      client.onNotification = (method, p) => {
        if (method === "owned_member_file_changed") { this.watches.get(p.id)?.({ path: p.path, change: p.change }); return; }
        if (method === "owned_member_release" || method === "owned_member_cancel_admission") {
          const lease = this.admissions.get(p.id); lease?.abort.abort(); lease?.release?.(); this.admissions.delete(p.id); return;
        }
        const n = p.notification;
        if (!n) return;
        this.notifications = this.notifications.then(async () => {
          if (this.closed) return;
          if (["agent_turn_completed", "session_token_usage_changed"].includes(n.type)) await this.refresh(client);
          else if (n.type === "agent_working_state_changed" && this.snapshot) this.snapshot.isAgentLoopInProgress = n.newState !== "idle";
          else if (n.type === "settings_updated" && this.snapshot) this.snapshot.settings = n.settings;
          else if (n.type === "create_message" && this.snapshot && n.message) this.snapshot.messages.push(n.message);
          this.host.notify(n);
        }).catch((e) => this.log?.(`[remote member] notification: ${e.message}`));
      };
      const tools = this.host.tools([]).map(({ run: _run, ...descriptor }) => descriptor);
      try { await client.request("prepare_workstream_member", { sessionId: this.remote.sessionId, maxAutonomy: this.maxAutonomy, maxToolIds: this.limits.maxToolIds, allowedModels: this.limits.allowedModelIds?.(), sharedPath: this.remote.sharedPath, tools }); return client; }
      catch (e) { await client.close(); throw e; }
    })();
  }
  private async refresh(client: RpcClient) { this.snapshot = await client.request("owned_session_snapshot", {}); }
  async call(method: string, params: Record<string, unknown> = {}) {
    const client = await this.connect();
    if (method === "initialize_session" && params.worktree && typeof params.worktree === "object" && (params.worktree as any).enabled) {
      const workspace = await client.request<{ repoRoot?: string }>("machine_workspace_info", { cwd: params.cwd });
      if (!workspace.repoRoot) params = { ...params, worktree: false };
    }
    const result = await client.request(method, params);
    if (method === "answer_request" && typeof params.requestId === "string") this.prompts.get(params.requestId)?.answer(params.answer);
    if (["initialize_session", "load_session", "update_session_settings", "add_user_message", "owned_member_message"].includes(method)) {
      await this.refresh(client);
      if (method === "initialize_session" || method === "load_session") {
        new RemoteSessionStore().update({ sessionId: this.remote.sessionId, machine: this.remote.machine, cwd: this.snapshot!.cwd, title: params.title as string ?? "Workstream member", updatedAt: new Date().toISOString(), pinned: false, archivedAt: null, isSubagent: true, hasUserVisibleMessages: true });
      }
    }
    return result;
  }
  private releaseAll() { for (const lease of this.admissions.values()) { lease.abort.abort(); lease.release?.(); } this.admissions.clear(); }
  watchFiles(id: string, glob: string, fire: (event: Record<string, unknown>) => void) {
    this.watches.set(id, fire);
    const ready = this.call("watch_owned_member_files", { id, glob }).then(() => {});
    return { ready, stop: () => { this.watches.delete(id); if (!this.closed) void this.call("unwatch_owned_member_files", { id }).catch((e) => this.log?.(`Remote unwatch: ${e.message}`)); } };
  }
  async close() {
    this.closed = true; this.resolveClosed(); this.releaseAll(); this.watches.clear();
    if (this.client) await this.client.close();
    if (this.opening) try { await this.opening; } catch {}
    await this.notifications;
  }
}

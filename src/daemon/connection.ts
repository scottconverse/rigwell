// One client connection = one session (spec §3.1.4 default). Maps protocol methods to a Session.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AutonomyLevel, CommandLists, InteractionMode, Message, ReasoningEffort, Tool } from "../core/types.ts";
import { ErrorCodes, METHOD_PREFIX, RpcError, RpcPeer } from "../protocol/rpc.ts";
import { Session, SessionBusyError, type SessionHost, type SessionSettings } from "../agent/session.ts";
import { applyCompaction } from "../agent/compaction.ts";
import { AUTO_MODEL_ID, type RouterConfig } from "../agent/router.ts";
import { parseFallbackModels } from "../agent/fallback-config.ts";
import { featureEnabled } from "../features/features.ts";
import { autonomyAllowed, clampAutonomy, modelAllowed } from "../storage/org.ts";
import { handoffBrief, isHandoffId, loadHandoff } from "../agent/handoff.ts";
import { hasProjectConfig, isFolderTrusted, loadSettings, trustFolder } from "../storage/settings.ts";
import { findModel, listModelInfo, resolveModels, validateCustomModels } from "../storage/models.ts";
import { appendAnalyticsMetric, appendCompaction, appendMessage, appendTitle, appendTodoState, appendTurnOutcome, createSession, findSession, loadTranscript, type SessionFiles } from "../storage/transcript.ts";
import { listSessionEntries, searchSessions } from "../storage/session-list.ts";
import { outputFormatFrom, systemPromptFrom, tagsFrom, toolIdUpdates, toolIdsFrom, userMessageFrom } from "./params.ts";
import { gitRepoOf } from "./gitrepo.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { hostId, isValidSessionId, rigwellHome } from "../storage/paths.ts";
import { createAdapter } from "../adapters/index.ts";
import { streamWithRetry } from "../adapters/retry.ts";
import { toolsForSession } from "../tools/registry.ts";
import { decide } from "../permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";
import { discardSessionWorktree, handleWorktreeMethod, onSessionArchived, onSessionTitleUpdated, runSessionSetup, startSessionWorktree, worktreeSettings, type SessionWorktree } from "../worktree/connect.ts";
import type { ToolExecutionMode } from "../core/types.ts";
import { HookRunner, loadHooksConfig } from "../hooks/index.ts";
import { fromInitConfigs, type McpServerInitConfig } from "../mcp/index.ts";
import { loadAgents } from "../subagents/agents.ts";
import { TaskLimits } from "../subagents/task.ts";
import { forkSession } from "../storage/fork.ts";
import { handleAuthMethod } from "../auth/methods.ts";
import { handleCodeProviderMethod, type CodeProviderDeps } from "../auth/code-providers.ts";
import { handleSecretsMethod } from "../secrets/methods.ts";
import { SecretsError, redactSecrets, resolveEnvironment, type ResolvedEnvironment } from "../secrets/store.ts";
import { RewindError, rewindSession } from "../snapshots/index.ts";
import { automationSetupParams } from "../automations/setup.ts";
import type { RpcClient } from "../sdk/client.ts";
import { RemoteSessionStore } from "../machines/sessions.ts";

/** Sessions whose client went away while a prompt was open: kept for a reconnecting load_session (spec 3.1.5 pending lists). */
const parked = new Map<string, { session: Session; files: SessionFiles; worktree?: SessionWorktree; timer: ReturnType<typeof setTimeout> }>();
const parkMs = () => Number(process.env.RIGWELL_PARK_MS) || 30 * 60_000;

export interface ConnectionOptions {
  fleetOptions?: import("../machines/fleet.ts").FleetOptions;
  shareDeps?: import("../sharing/transfer.ts").ShareTransferDeps;
  machineControl?: { stopSessions(): Promise<unknown>; shutdown(build: unknown): unknown };
  /** Injected SSH connection factory for fake-process acceptance; production uses the saved machine. */
  connectMachine?: (name: string) => Promise<RpcClient>;
  codeProviderDeps?: CodeProviderDeps;
  reviewHostDeps?: import("../review/host.ts").ReviewHostDeps;
  /** Owned sessions publish committed user messages to their live transcript views. */
  notifyUserMessages?: boolean;
  /** An owned live session can have transcript/control views without another engine or replacing its host. */
  sharedSession?: (id: string) => { session: Session; alive(): boolean; subscribe(notify: (n: Record<string, unknown>) => void): () => void } | undefined;
  sharedRemoteSession?: (id: string) => { machine: string; request(method: string, p: Record<string, unknown>): Promise<any>; alive(): boolean; subscribe(notify: (n: Record<string, unknown>) => void): () => void } | undefined;
  maxToolIds?: string[];
  beforeTurn?: import("../agent/session.ts").SessionDeps["beforeTurn"];
  onUsage?: import("../agent/session.ts").SessionDeps["onUsage"];
  beforeModel?: (model: import("../core/types.ts").ModelConfig) => void;
  /** Observes normal session notifications without changing the session's host. */
  onNotification?: (session: Session | undefined, notification: Record<string, unknown>) => void;
  /** An owned member session cannot raise its autonomy above its lead's cap. */
  maxAutonomy?: AutonomyLevel;
  /** The client can answer rigwell.request_permission (stream-jsonrpc). False for plain `exec "prompt"`. */
  canPrompt: boolean;
  runtimeSettingsPath?: string;
  /** Values from exec flags; they override what initialize_session asks for. */
  forced?: { autonomyLevel?: AutonomyLevel; skipPermissions?: boolean; modelId?: string; machine?: string };
  retryBaseDelayMs?: number;
  /** Extra protocol methods (name without the prefix), e.g. the daemon's automation methods. */
  extraMethods?: Record<string, (p: Record<string, unknown>) => unknown>;
  /** Extra agent tools for every session on this connection (e.g. the side pane's Browser tool). */
  extraTools?: () => Tool[];
  /** Rewrites the tool list of every session on this connection (missions: role tools and file protection). */
  wrapTools?: (tools: Tool[]) => Tool[];
  log?: (m: string) => void;
}

const AUTONOMY = ["off", "low", "medium", "high"];
const MODES = ["auto", "spec", "mission"];
const EXEC_MODES = ["direct_only", "script_only"];
const EFFORTS = ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

function pick<T extends string>(v: unknown, allowed: string[], name: string): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid ${name}: ${JSON.stringify(v)}`);
  return v as T;
}

const SHELL = Bun.which("bash") ? "bash" : "sh";

/** One limit tracker per process, shared by every connection (spec 5.9 Limits). Settings `subagentLimits` set it on first use. */
let processLimits: TaskLimits | undefined;
const limitsFor = (s: Record<string, unknown>) => (processLimits ??= new TaskLimits((s.subagentLimits as any) ?? {}));

export function createConnection(write: (line: string) => void, opts: ConnectionOptions) {
  const fleet = async () => new (await import("../machines/fleet.ts")).MachineFleet({ ...opts.fleetOptions, connect: opts.connectMachine ?? opts.fleetOptions?.connect });
  let session: Session | undefined;
  let files: SessionFiles | undefined;
  let closed = false;
  let worktree: SessionWorktree | undefined;
  let shared: ReturnType<NonNullable<ConnectionOptions["sharedSession"]>>;
  let sharedRemote: ReturnType<NonNullable<ConnectionOptions["sharedRemoteSession"]>>;
  let sharedRemoteId: string | undefined;
  let unsubscribeShared: (() => void) | undefined;
  let reviews: import("../review/service.ts").ReviewService | undefined;
  let remote: RpcClient | undefined, remoteName: string | undefined;
  let openingRemote: Promise<RpcClient> | undefined, shuttingDown = false;
  let remoteSessionId: string | undefined;
  let remoteWorker: ReturnType<typeof import("../machines/mission-worker.ts").prepareMissionWorker> | undefined;
  let remoteMember: import("../machines/member-role.ts").RemoteMemberRole | undefined;

  const peer: RpcPeer = new RpcPeer(write, (m, p) => handle(m, p), opts.log);

  const notify = (n: Record<string, unknown>) => {
    if (!shared && !sharedRemote) opts.onNotification?.(session, n);
    peer.notify(METHOD_PREFIX + "session_notification", { ...(session ? { sessionId: session.id } : {}), notification: n });
    // A generated title renames a generated worktree branch (spec 18.2).
    if (n.type === "session_title_updated" && n.updateType !== "manual" && worktree && session && typeof n.title === "string") {
      void onSessionTitleUpdated(session.id, n.title, undefined, opts.log).catch(() => {});
    }
  };

  function need(): Session {
    if (closed || (shared && !shared.alive())) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "The session owner has ended");
    if (!session) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "No session: call initialize_session or load_session first");
    return session;
  }

  const trustCache = new Map<string, boolean>();

  /** Trust without asking anyone: the process flag, or the user's trustedFolders (spec 12.2). */
  function trustedSync(cwd: string): boolean {
    const c = trustCache.get(cwd);
    if (c !== undefined) return c;
    const user = loadSettings({ cwd, runtimeSettingsPath: opts.runtimeSettingsPath, trusted: false }).settings;
    return isFolderTrusted(cwd, user.trustedFolders);
  }

  /** Is this folder trusted? An interactive client is asked once (rigwell.request_trust) when the folder has project config. */
  async function resolveTrust(cwd: string): Promise<boolean> {
    let t = trustedSync(cwd);
    if (!t && opts.canPrompt && hasProjectConfig(cwd)) {
      try {
        const a = (await peer.request(METHOD_PREFIX + "request_trust", {
          cwd, unlocks: ["project settings", "hooks", "instruction files (AGENTS.md)", "project skills", "custom agents", "project MCP servers"],
        })) as { trust?: boolean; remember?: boolean } | undefined;
        t = a?.trust === true;
        if (t && a?.remember !== false) trustFolder(cwd);
      } catch { t = false; }
    }
    if (!t && hasProjectConfig(cwd)) opts.log?.(`[trust] ${cwd} is not trusted: project settings, hooks, instruction files, skills, agents and MCP servers were not loaded`);
    trustCache.set(cwd, t);
    return t;
  }

  function environment(cwd: string) {
    const trusted = trustedSync(cwd);
    const loaded = loadSettings({ cwd, runtimeSettingsPath: opts.runtimeSettingsPath, trusted });
    for (const w of loaded.warnings) opts.log?.(`[settings] ${w}`);
    const s = loaded.settings;
    // Org modelPolicy: blocked and not-allowed models disappear from the picker and cannot be selected (spec 12.2).
    // allowCustomModels=false already removed the lower levels' customModels when the settings were merged (storage/org.ts).
    const models = resolveModels(s).filter((m) => modelAllowed(s.modelPolicy, [m.id, m.model], false));
    const lists: CommandLists = {
      allow: s.commandAllowlist ?? DEFAULT_COMMAND_LISTS.allow,
      deny: s.commandDenylist ?? DEFAULT_COMMAND_LISTS.deny,
      block: s.commandBlocklist ?? DEFAULT_COMMAND_LISTS.block,
    };
    return { s, models, lists, trusted };
  }

  const hostFor = (): SessionHost => ({
    notify,
    requestPermission: opts.canPrompt ? async (params) => (await peer.request(METHOD_PREFIX + "request_permission", params)) as any : undefined,
    requestAskUser: opts.canPrompt ? async (params) => (await peer.request(METHOD_PREFIX + "ask_user", params)) as any : undefined,
  });

  /** Saved session settings as the params that created the session (load_session keeps them unless it passes new ones). */
  function savedParams(saved: Record<string, any>): Record<string, unknown> {
    const t = saved.toolIds ?? {};
    return {
      ...(t.restrict ? { restrictToolIds: t.restrict } : {}), ...(t.enabled ? { enabledToolIds: t.enabled } : {}),
      ...(t.disabled ? { disabledToolIds: t.disabled } : {}), ...(t.additional ? { additionalToolIds: t.additional } : {}),
      ...(saved.systemPrompt ? { systemPrompt: saved.systemPrompt } : {}), ...(saved.structuredOutputFormat ? { structuredOutputFormat: saved.structuredOutputFormat } : {}),
      ...(saved.disableBuiltinSkills ? { disableBuiltinSkills: true } : {}),
      ...(typeof saved.environment === "string" ? { environment: saved.environment } : {}),
      ...(Array.isArray(saved.tags) ? { tags: saved.tags } : {}),
    };
  }

  /** The session's named environment (initialize_session `environment`): variables for Execute and hooks, never for the prompt. */
  function sessionEnvironment(p: Record<string, unknown>): ResolvedEnvironment | undefined {
    if (p.environment === undefined || p.environment === null || p.environment === "") return undefined;
    if (typeof p.environment !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "environment must be a string");
    try { return resolveEnvironment(p.environment); } catch (e) {
      if (e instanceof SecretsError) throw new RpcError(e.kind === "not_found" ? ErrorCodes.ENTITY_NOT_FOUND : ErrorCodes.INVALID_PARAMS, e.message);
      throw e;
    }
  }

  function pendingLists(s: Session) {
    const ps = s.pendingPrompts();
    return {
      pendingPermissions: ps.filter((x) => x.kind === "permission").map((x) => x.params),
      pendingAskUserRequests: ps.filter((x) => x.kind === "ask_user").map((x) => x.params),
      pendingPickOptionsRequests: [] as unknown[],
      queuedMessages: s.queuedMessages().map((m) => ({ text: m.text, messageId: m.messageId, requestId: m.messageId, ...(m.content ? { content: m.content } : {}) })),
    };
  }

  function routerOf(env: ReturnType<typeof environment>): RouterConfig | undefined {
    const r = env.s.autoRouter as RouterConfig | undefined;
    return r && Array.isArray(r.candidates) && r.candidates.length && typeof r.classifierModel === "string" ? r : undefined;
  }

  const modelOk = (env: ReturnType<typeof environment>, id: string) => !!findModel(env.models, id) || (id === AUTO_MODEL_ID && !!routerOf(env));

  function persistenceFor(f: SessionFiles) {
    return {
      appendMessage: async (msg: Message, parent: string | null) => { await appendMessage(f, msg, parent); if (opts.notifyUserMessages && msg.role === "user" && msg.visibility !== "llm_only") notify({ type: "create_message", message: msg }); },
      appendTurnOutcome: (o: { turnId: string; reason: string; resultKind: "text" | "structured" | null }) => appendTurnOutcome(f, o),
      appendTodoState: (todos: any, idx: number) => appendTodoState(f, todos, idx),
      setTitle: async (title: string, manual: boolean) => { await appendTitle(f, title, manual); updateSessionSettings(f, { title, isSessionTitleManuallySet: manual }); },
      appendCompaction: (rec: any) => appendCompaction(f, rec),
      appendAnalyticsMetric: (metric: import("../storage/analytics-records.ts").AnalyticsMetric) => appendAnalyticsMetric(f, metric),
      saveSettings: async (patch: Record<string, unknown>) => { updateSessionSettings(f, patch); },
    };
  }

  function build(id: string, cwd: string, settings: SessionSettings, p: Record<string, unknown>, env: ReturnType<typeof environment>, override: ToolExecutionMode | undefined, restored?: { previousSessionId?: string; callingSessionId?: string; allowSubagentsInScripts?: boolean; messages: Message[]; tokenUsage?: any; deferred?: { loaded: string[]; announced: string[] }; archived?: Message[]; anchor?: string; todos?: any; title?: { value: string; manual: boolean } }) {
    // An org autonomy ceiling below high also rules out skip-permissions (it is the highest level of all).
    const ownerCap = remoteMember?.maxAutonomy ?? opts.maxAutonomy;
    const maxAutonomy = ownerCap ? clampAutonomy(ownerCap, env.s.maxAutonomyLevel) : env.s.maxAutonomyLevel;
    const skip = (opts.forced?.skipPermissions ?? p.skipPermissionsUnsafe === true) && autonomyAllowed("high", maxAutonomy);
    const f = files!;
    const hooksConfig = loadHooksConfig({ cwd, trustProject: env.trusted });
    const sessionEnv = sessionEnvironment(p);
    return new Session({
      id, cwd, settings,
      ...(sessionEnv ? { extraEnv: sessionEnv.env, redact: (t: string) => redactSecrets(t, sessionEnv.secrets) } : {}),
      resolveModel: (mid) => findModel(env.models, mid),
      createAdapter: (model) => { opts.beforeModel?.(model); remoteMember?.beforeModel(model); return createAdapter(model); }, streamWithRetry: streamWithRetry as any,
      beforeTurn: remoteMember?.beforeTurn ?? opts.beforeTurn, onUsage: remoteMember?.onUsage ?? opts.onUsage, maxToolIds: remoteMember?.maxToolIds ?? opts.maxToolIds,
      toolsFor: (o) => {
        const extra = opts.extraTools?.() ?? [], names = new Set(extra.map((t) => t.name));
        const base = [...toolsForSession(o).filter((t) => !names.has(t.name)), ...extra];
        const wrapped = opts.wrapTools ? opts.wrapTools(base) : base;
        return remoteWorker ? remoteWorker.wrap(wrapped) : remoteMember ? remoteMember.wrap(wrapped) : wrapped;
      }, decide: ownerCap && !autonomyAllowed("high", maxAutonomy)
        ? (tool, input, ctx) => decide(tool, input, { ...ctx, interactionMode: ctx.interactionMode === "mission" ? "auto" : ctx.interactionMode })
        : decide, lists: env.lists,
      scriptToolModels: env.s.scriptToolModels, scriptLimits: env.s.scriptLimits,
      toolExecutionModeOverride: override,
      skipPermissions: skip,
      autoRejectPermissionRequests: p.autoRejectPermissionRequests === true,
      shell: SHELL, retryBaseDelayMs: opts.retryBaseDelayMs,
      fallbackModels: parseFallbackModels(loadSettings({ cwd: rigwellHome(), trusted: false }).settings.fallbackModels),
      messages: restored?.messages, tokenUsage: restored?.tokenUsage, deferred: restored?.deferred, log: opts.log,
      todos: restored?.todos, title: restored?.title ?? (typeof p.title === "string" && p.title ? { value: p.title, manual: true } : undefined),
      tags: tagsFrom(p.tags), toolIds: toolIdsFrom(p), systemPrompt: systemPromptFrom(p), structuredOutputFormat: outputFormatFrom(p.structuredOutputFormat, "structuredOutputFormat"),
      disableBuiltinSkills: p.disableBuiltinSkills === true, projectTrusted: env.trusted,
      profileSettings: { modelProfiles: env.s.modelProfiles as any, fileEditToolProfile: env.s.fileEditToolProfile as any },
      compactionTokenLimitPerModel: env.s.compactionTokenLimitPerModel as any, subagentModelSettings: env.s.subagentModelSettings as any,
      autoTitle: env.s.autoSessionTitle !== false, heartbeatMs: typeof env.s.toolHeartbeatMs === "number" ? env.s.toolHeartbeatMs : undefined,
      archived: restored?.archived, compactionAnchorId: restored?.anchor,
      guardSettings: { llmRequestTimeout: env.s.llmRequestTimeout as number | undefined, loopGuards: env.s.loopGuards as any },
      toolResultModelChars: typeof env.s.toolResultModelChars === "number" && env.s.toolResultModelChars > 0 ? env.s.toolResultModelChars : undefined,
      previousSessionId: restored?.previousSessionId, callingSessionId: restored?.callingSessionId ?? (typeof p.callingSessionId === "string" && p.callingSessionId ? p.callingSessionId : undefined),
      enterMissionMode: opts.extraMethods?.enter_mission_mode ? async () => (await opts.extraMethods!.enter_mission_mode!({})) as Record<string, unknown> : undefined,
      modelUpgradePath: Array.isArray(env.s.modelUpgradePath) ? (env.s.modelUpgradePath as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
      compaction: env.s.compaction as any, compactionTokenLimit: env.s.compactionTokenLimit,
      maxAutonomy, enableSecretScan: env.s.enableSecretScan === true,
      compactionModelMode: env.s.compactionModelMode === "current-model" ? "current-model" : "default",
      compactionThresholdCheckEnabled: env.s.compactionThresholdCheckEnabled, router: routerOf(env),
      persistence: persistenceFor(f),
      transcriptPath: f.transcriptPath,
      hooksFor: (a) => new HookRunner({
        config: hooksConfig, sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd, permissionMode: a.permissionMode, notify: a.notify, env: sessionEnv?.env,
      }),
      mcp: { servers: fromInitConfigs(p.mcpServers as McpServerInitConfig[] | undefined) },
      allowSubagentsInScripts: featureEnabled("script_subagents", restored?.allowSubagentsInScripts ?? (p.allowSubagentsInScripts === true || env.s.allowSubagentsInScripts === true)),
      specSaveDir: typeof env.s.specSaveDir === "string" ? env.s.specSaveDir : undefined,
      subagents: {
        limits: limitsFor(env.s), depth: 0, rootSessionId: id,
        agents: loadAgents({ cwd, isValidModel: (m) => !!findModel(env.models, m), projectTrusted: env.trusted }).agents,
        openChild: (o) => {
          const cf = createSession({ id: o.id, cwd: o.cwd, title: o.title, extra: { callingSessionId: o.callingSessionId, callingToolUseId: o.callingToolUseId } });
          updateSessionSettings(cf, { tags: [{ name: "subagent", metadata: { subagent: 1, depth: o.depth, ...(o.agentName ? { agent: o.agentName } : {}) } }] });
          return { persistence: persistenceFor(cf), transcriptPath: cf.transcriptPath };
        },
      },
    }, hostFor());
  }

  /** Spec mode model and effort (spec 5.5.7): initialize_session params, else sessionDefaultSettings.specModeModel / specModeReasoningEffort. */
  function specSettings(p: Record<string, unknown>, d: Record<string, unknown>, env: ReturnType<typeof environment>): Partial<SessionSettings> {
    const model = (p.specModeModelId ?? d.specModeModel) as unknown;
    const effort = pick<ReasoningEffort>(p.specModeReasoningEffort ?? d.specModeReasoningEffort, EFFORTS, "specModeReasoningEffort");
    return {
      ...(typeof model === "string" && findModel(env.models, model) ? { specModeModelId: model } : {}),
      ...(effort ? { specModeReasoningEffort: effort } : {}),
    };
  }

  /** `page` (load_session): messageLimit keeps the newest N visible messages unless loadAllMessages; adds hasOlderMessages. */
  function sessionResult(page?: { loadAll: boolean; limit?: number }) {
    const s = need();
    const all = s.uiMessages().filter((m) => m.visibility !== "llm_only");
    const cut = page && !page.loadAll && page.limit !== undefined && all.length > page.limit;
    const git = gitRepoOf(s.cwd);
    return {
      sessionId: s.id, hostId: hostId(),
      session: { messages: cut ? all.slice(-page!.limit!) : all },
      settings: s.settingsSnapshot(),
      ...(page ? { hasOlderMessages: !!cut } : {}),
      ...(git ? { gitRepo: git } : {}),
    };
  }

  function pageFrom(p: Record<string, unknown>) {
    if (p.loadAllMessages !== undefined && typeof p.loadAllMessages !== "boolean") throw new RpcError(ErrorCodes.INVALID_PARAMS, "loadAllMessages must be a boolean");
    if (p.messageLimit !== undefined && (typeof p.messageLimit !== "number" || !Number.isInteger(p.messageLimit) || p.messageLimit < 1)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "messageLimit must be a positive integer");
    return { loadAll: p.loadAllMessages === true, limit: p.messageLimit as number | undefined };
  }

  async function handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    if (shuttingDown) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "Connection is closing");
    if (method === "load_session" && !session && !remote && !sharedRemote && typeof p.sessionId === "string") {
      sharedRemote = opts.sharedRemoteSession?.(p.sessionId);
      if (sharedRemote) { sharedRemoteId = p.sessionId; unsubscribeShared = sharedRemote.subscribe((n) => peer.notify(METHOD_PREFIX + "session_notification", { sessionId: p.sessionId, notification: n })); }
    }
    if (sharedRemote) {
      if ((method === "load_session" && p.sessionId !== sharedRemoteId) || method === "initialize_session" || method === "start_automation_setup") throw new RpcError(ErrorCodes.CONFLICT, "This view belongs to one remote member");
      if (closed || !sharedRemote.alive()) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "The remote member owner has ended");
      if (method === "close_session") { unsubscribeShared?.(); unsubscribeShared = undefined; closed = true; return {}; }
      const result = await sharedRemote.request(method, p);
      return method === "load_session" ? { ...result, machine: sharedRemote.machine } : result;
    }
    if (method === "initialize_session" || method === "load_session" || method === "start_automation_setup") {
      if (opts.forced?.machine) p = { ...p, machine: opts.forced.machine };
      if (remoteWorker) {
        if (method === "start_automation_setup" || p.sessionId !== remoteWorker.dir.split(/[\\/]/).at(-1)) throw new RpcError(ErrorCodes.CONFLICT, "Owned worker cannot select another session");
        p = { ...p, cwd: remoteWorker.cwd, interactionMode: "auto", autoRejectPermissionRequests: true, autonomyLevel: "high", skipPermissionsUnsafe: false };
      }
      if (remoteMember && (method === "start_automation_setup" || p.sessionId !== remoteMember.sessionId)) throw new RpcError(ErrorCodes.CONFLICT, "Owned member cannot select another session");
      if (method === "load_session" && p.machine === undefined && typeof p.sessionId === "string" && !findSession(p.sessionId)) {
        const saved = new RemoteSessionStore().get(p.sessionId); if (saved) p = { ...p, machine: saved.machine, cwd: saved.cwd };
      }
      if (p.machine !== undefined && (typeof p.machine !== "string" || !p.machine)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "machine must be a saved machine name");
      if (typeof p.machine === "string" && !["local", "default"].includes(p.machine)) {
        if (session || remote || openingRemote) throw new RpcError(ErrorCodes.CONFLICT, "This connection already selected a session machine");
        if (opts.maxAutonomy || opts.maxToolIds || opts.beforeTurn) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Owned member sessions require the constrained remote member service");
        remoteName = p.machine;
        openingRemote = (opts.connectMachine ?? (async (name) => (await import("../machines/bootstrap.ts")).connectMachine(name, { log: opts.log })))(remoteName);
        try {
          remote = await openingRemote;
          if (shuttingDown) { await remote.close(); throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "Connection closed during SSH startup"); }
          remote.onNotification = (m, params) => {
            const n = params.notification;
            if (remoteSessionId && ["session_title_updated", "agent_turn_completed"].includes(n?.type)) {
              const store = new RemoteSessionStore(), saved = store.get(remoteSessionId);
              if (saved) store.update({ ...saved, updatedAt: new Date().toISOString(), ...(n?.type === "session_title_updated" && typeof n.title === "string" ? { title: n.title } : {}) });
            }
            opts.onNotification?.(undefined, n ?? {}); peer.notify(METHOD_PREFIX + m, params);
          };
          remote.onRequest = (m, params) => opts.canPrompt ? peer.request(METHOD_PREFIX + m, params) : { selectedOption: "cancel", cancelled: true, answers: [], trust: false };
        } catch (e) { remote = undefined; remoteName = undefined; throw e; }
        finally { openingRemote = undefined; }
      }
    }
    if (openingRemote) await openingRemote;
    if (remote) {
      if (p.machine !== undefined && p.machine !== remoteName) throw new RpcError(ErrorCodes.CONFLICT, "A connection cannot change its machine");
      const { machine: _machine, ...params } = p;
      if (!opts.canPrompt && ["initialize_session", "load_session"].includes(method)) params.autoRejectPermissionRequests = true;
      if (["initialize_session", "load_session"].includes(method)) {
        if (opts.forced?.autonomyLevel) params.autonomyLevel = opts.forced.autonomyLevel;
        if (opts.forced?.modelId) params.modelId = opts.forced.modelId;
        if (opts.forced?.skipPermissions) params.skipPermissionsUnsafe = true;
      }
      const result = await remote.request(method, params);
      if (["initialize_session", "load_session", "start_automation_setup"].includes(method) && typeof result?.sessionId === "string") {
        if (findSession(result.sessionId)) throw new RpcError(ErrorCodes.CONFLICT, "Remote session id collides with a local session");
        remoteSessionId = result.sessionId;
        const store = new RemoteSessionStore(), saved = store.get(remoteSessionId!);
        store.update({ sessionId: remoteSessionId!, machine: remoteName!, cwd: result.cwd ?? params.cwd ?? saved?.cwd, title: result.title ?? params.title ?? saved?.title ?? "Untitled", updatedAt: new Date().toISOString(), pinned: saved?.pinned ?? false, archivedAt: saved?.archivedAt ?? null, isSubagent: false, hasUserVisibleMessages: saved?.hasUserVisibleMessages ?? method === "load_session" });
      } else if (method === "fork_session" && typeof result?.newSessionId === "string" && remoteSessionId) {
        const store = new RemoteSessionStore(), saved = store.get(remoteSessionId);
        if (saved) store.update({ ...saved, sessionId: result.newSessionId, updatedAt: new Date().toISOString(), pinned: false, archivedAt: null });
      } else if (remoteSessionId) {
        const store = new RemoteSessionStore(), saved = store.get(remoteSessionId);
        if (saved) store.update({ ...saved, updatedAt: new Date().toISOString(), ...(method === "add_user_message" ? { hasUserVisibleMessages: true } : {}), ...(method === "rename_session" && typeof p.title === "string" ? { title: p.title } : {}), ...(method === "pin_session" ? { pinned: p.pinned === true } : {}), ...(method === "archive_session" ? { archivedAt: p.archived ? new Date().toISOString() : null } : {}) });
      }
      return ["initialize_session", "load_session", "start_automation_setup"].includes(method) ? { ...result, machine: remoteName } : result;
    }
    switch (method) {
      case "prepare_workstream_member": {
        if (session || remoteWorker || remoteMember) throw new RpcError(ErrorCodes.CONFLICT, "Member role must be selected before opening a session");
        remoteMember = new (await import("../machines/member-role.ts")).RemoteMemberRole(p, peer);
        return {};
      }
      case "machine_workspace_info": {
        if (typeof p.cwd !== "string" || !p.cwd) throw new RpcError(ErrorCodes.INVALID_PARAMS, "cwd is required");
        const cwd = resolve(p.cwd);
        if (!existsSync(cwd)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Remote working directory does not exist");
        return { cwd, repoRoot: await (await import("../worktree/git.ts")).repoTopLevel(cwd) };
      }
      case "cleanup_owned_member_worktree": {
        if (!remoteMember || !closed || !session) throw new RpcError(ErrorCodes.CONFLICT, "Close the owned member before cleanup");
        if (!worktree) return { removed: false, worktreeKept: false };
        const manager = worktree.manager, wt = await manager.get(worktree.info.path);
        if (!wt) return { removed: false, worktreeKept: false };
        if (!await manager.isSafeToRemove(wt)) return { removed: false, worktreeKept: true };
        await manager.remove(wt.path);
        return { removed: true, worktreeKept: false };
      }
      case "watch_owned_member_files": {
        if (!remoteMember || !worktree || closed) throw new RpcError(ErrorCodes.CONFLICT, "No active owned member worktree");
        remoteMember.watchFiles(p.id, p.glob, worktree.info.path, opts.log); return {};
      }
      case "unwatch_owned_member_files": {
        if (!remoteMember || typeof p.id !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid member watch");
        remoteMember.unwatch(p.id); return {};
      }
      case "owned_member_message": {
        if (!remoteMember) throw new RpcError(ErrorCodes.CONFLICT, "No owned member");
        const um = userMessageFrom(p);
        if (p.placement !== undefined && !["now", "end_of_loop", "end_of_turn"].includes(p.placement as string)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid member message priority");
        need().addUserMessage(um.text, typeof p.messageId === "string" ? p.messageId : undefined, typeof p.userMessageSource === "string" ? p.userMessageSource : undefined, { placement: p.placement as "now" | "end_of_loop" | "end_of_turn" | undefined });
        return {};
      }
      case "prepare_mission_worker": {
        if (session || remoteWorker) throw new RpcError(ErrorCodes.CONFLICT, "Worker role must be selected before opening a session");
        const { checkFeaturesJson } = await import("../missions/store.ts");
        const invalid = checkFeaturesJson(JSON.stringify({ features: [p.feature] }));
        if (invalid) throw new RpcError(ErrorCodes.INVALID_PARAMS, invalid);
        remoteWorker = (await import("../machines/mission-worker.ts")).prepareMissionWorker(p, (input) => peer.request(METHOD_PREFIX + "owned_mission_tool", { sessionId: p.sessionId, input }));
        const { workerPrompt } = await import("../missions/runner.ts");
        return { dir: remoteWorker.dir, cwd: remoteWorker.cwd, prompt: workerPrompt(remoteWorker.dir, p.feature as import("../missions/store.ts").Feature, p.sessionId as string, remoteWorker.cwd, typeof p.extraMessage === "string" ? p.extraMessage : undefined) };
      }
      case "mission_worker_verify_commit": {
        if (!remoteWorker) throw new RpcError(ErrorCodes.CONFLICT, "No owned mission worker");
        if (typeof p.repo !== "string" || typeof p.commit !== "string" || !/^[a-fA-F0-9]{4,64}$/.test(p.commit)) return false;
        const { execFileSync } = await import("node:child_process");
        try { execFileSync("git", ["-C", p.repo, "cat-file", "-e", `${p.commit}^{commit}`], { stdio: "ignore", timeout: 5000, windowsHide: true }); return true; } catch { return false; }
      }
      case "mission_worker_library_snapshot": {
        if (!remoteWorker || p.sessionId !== remoteWorker.dir.split(/[\\/]/).at(-1)) throw new RpcError(ErrorCodes.CONFLICT, "No matching owned mission worker");
        const { missionPlanFiles } = await import("../machines/mission-worker.ts");
        return Object.fromEntries(Object.entries(missionPlanFiles(remoteWorker.dir)).filter(([path]) => path.startsWith("library/")));
      }
      case "owned_session_snapshot": {
        const s = need(); return { ...sessionResult(), cwd: s.cwd, messages: s.uiMessages(), tokenUsage: s.tokenUsage, isAgentLoopInProgress: s.isRunning, workingState: s.workingState, ...pendingLists(s), availableModels: listModelInfo(environment(s.cwd).models) };
      }
      case "machine_list": {
        const { MachineStore } = await import("../machines/store.ts");
        return { machines: new MachineStore().list() };
      }
      case "machine_add": {
        const { MachineStore, machineDefinition } = await import("../machines/store.ts");
        return { machine: new MachineStore().save(machineDefinition(p)) };
      }
      case "machine_bootstrap": {
        if (typeof p.name !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
        return { machine: await (await import("../machines/bootstrap.ts")).bootstrapMachine(p.name) };
      }
      case "machine_models": {
        if (typeof p.name !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
        const client = await (opts.connectMachine ?? (async (name) => (await import("../machines/bootstrap.ts")).connectMachine(name)))(p.name);
        try { return await client.request("list_models"); } finally { await client.close(); }
      }
      case "prepare_automation_workspace": {
        const paths = (await import("../machines/automation-workspace.ts")).automationWorkspace(p.automationId, p.cwd);
        const env = environment(paths.cwd);
        return { ...paths, models: listModelInfo(env.models), defaultModel: env.s.sessionDefaultSettings?.model ?? env.models[0]?.id };
      }
      case "machine_runtime_info": return (await import("../machines/runtime-info.ts")).machineRuntimeInfo();
      case "sync_status": return (await import("../sync/service.ts")).syncStatus();
      case "sync_configure": return (await import("../sync/service.ts")).configureSync(p.config);
      case "sync_now": return (await import("../sync/service.ts")).syncNow();
      case "sync_view": case "sync_restore": {
        if (typeof p.key !== "string" || (p.hash !== undefined && typeof p.hash !== "string") || (p.cwd !== undefined && typeof p.cwd !== "string")) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Valid sync item, optional hash and working directory required");
        const sync = await import("../sync/service.ts");
        return method === "sync_view" ? { readOnly: true, item: sync.syncedItem(p.key, p.hash) } : sync.restoreSyncedItem(p.key, { hash: p.hash, cwd: p.cwd });
      }
      case "export_session": {
        const id = typeof p.sessionId === "string" ? p.sessionId : need().id;
        if (p.format !== "html" && p.format !== "markdown") throw new RpcError(ErrorCodes.INVALID_PARAMS, "format must be html or markdown");
        const sharing = await import("../sharing/session.ts");
        return { content: sharing.renderSharedSession(sharing.sharedSession(id, { secrets: opts.shareDeps?.secrets }), p.format), format: p.format };
      }
      case "import_shared_session": {
        if (typeof p.source !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "source is required");
        return (await import("../sharing/transfer.ts")).importSharedSource(p.source, opts.shareDeps);
      }
      case "get_shared_session": case "fork_shared_session": {
        if (typeof p.importId !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "importId is required");
        const sharing = await import("../sharing/session.ts");
        if (method === "get_shared_session") return { readOnly: true, session: sharing.readImportedSession(p.importId) };
        if (typeof p.cwd !== "string" || !p.cwd) throw new RpcError(ErrorCodes.INVALID_PARAMS, "A working directory is required to fork an import");
        return sharing.forkImportedSession(p.importId, p.cwd);
      }
      case "share_session": {
        const id = typeof p.sessionId === "string" ? p.sessionId : need().id;
        return (await import("../sharing/transfer.ts")).shareSecretGist(id, opts.canPrompt ? (params) => peer.request(METHOD_PREFIX + "request_permission", params) : undefined, opts.shareDeps);
      }
      case "machine_fleet": return { machines: await (await fleet()).list() };
      case "machine_update_all": return (await fleet()).updateAll();
      case "machine_stop_sessions": {
        if (!opts.machineControl) throw new Error("Machine administration requires a daemon connection");
        return opts.machineControl.stopSessions();
      }
      case "machine_shutdown": {
        if (!opts.machineControl) throw new Error("Machine administration requires a daemon connection");
        return opts.machineControl.shutdown(p.build);
      }
      case "machine_restart": case "machine_update": case "machine_stop": case "machine_remove": {
        if (typeof p.name !== "string" || !p.name) throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
        const controller = await fleet();
        if (method === "machine_restart") return { machine: await controller.restart(p.name) };
        if (method === "machine_update") return { machine: await controller.update(p.name) };
        if (method === "machine_stop") return controller.stop(p.name);
        return controller.remove(p.name);
      }
      case "start_automation_setup": {
        // Guided "create by chatting" (spec 16.8): a normal session with the setup block added to its system prompt.
        if (typeof p.cwd !== "string" || !p.cwd) throw new RpcError(ErrorCodes.INVALID_PARAMS, "cwd is required");
        return { ...(await handle("initialize_session", automationSetupParams(p)) as Record<string, unknown>), automationSetup: true };
      }
      case "initialize_session": {
        if (session) throw new RpcError(ErrorCodes.CONFLICT, "This connection already has a session");
        if (typeof p.cwd !== "string" || !p.cwd) throw new RpcError(ErrorCodes.INVALID_PARAMS, "cwd is required");
        const cwd = resolve(p.cwd);
        if (!existsSync(cwd)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `cwd does not exist: ${cwd}`);
        const id = p.sessionId === undefined ? crypto.randomUUID() : String(p.sessionId);
        if (!isValidSessionId(id)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid sessionId");
        // Spec handoff (spec 5.5.7): the record's plan is this session's brief, at the autonomy level the user chose.
        let handoff: ReturnType<typeof loadHandoff> = null;
        if (p.specHandoffId !== undefined) {
          handoff = isHandoffId(p.specHandoffId) ? loadHandoff(p.specHandoffId) : null;
          if (!handoff) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown specHandoffId: ${JSON.stringify(p.specHandoffId)}`);
        }
        if (findSession(id, cwd)) throw new RpcError(ErrorCodes.CONFLICT, `Session ${id} already exists; use load_session`);
        // Check the structured params before anything is created.
        toolIdsFrom(p); systemPromptFrom(p); outputFormatFrom(p.structuredOutputFormat, "structuredOutputFormat"); tagsFrom(p.tags);
        sessionEnvironment(p);
        await resolveTrust(cwd);
        const env = environment(cwd);
        const d = env.s.sessionDefaultSettings ?? {};
        const modelId = opts.forced?.modelId ?? (p.modelId as string | undefined) ?? d.model ?? env.models[0]?.id;
        if (!modelId || !modelOk(env, modelId)) {
          throw new RpcError(ErrorCodes.INVALID_PARAMS, modelId ? `Unknown model: ${modelId}` : "No models configured: add customModels to settings.json");
        }
        const settings: SessionSettings = {
          modelId,
          reasoningEffort: pick<ReasoningEffort>(p.reasoningEffort, EFFORTS, "reasoningEffort") ?? (d.reasoningEffort as ReasoningEffort) ?? "high",
          interactionMode: pick<InteractionMode>(p.interactionMode, MODES, "interactionMode") ?? (d.interactionMode as InteractionMode) ?? "auto",
          autonomyLevel: opts.forced?.autonomyLevel ?? pick<AutonomyLevel>(p.autonomyLevel, AUTONOMY, "autonomyLevel") ?? handoff?.autonomyLevel ?? (d.autonomyLevel as AutonomyLevel) ?? "off",
          ...(env.s.compactionModel && findModel(env.models, env.s.compactionModel) ? { compactionModelId: env.s.compactionModel } : {}),
          ...specSettings(p, d, env),
        };
        // Optional git worktree (spec §18): the session's cwd becomes the worktree path.
        worktree = (await startSessionWorktree(p.worktree, cwd, id, env.s, opts.log)) ?? undefined;
        const sessionCwd = worktree?.cwd ?? cwd;
        try {
          files = createSession({ id, cwd: sessionCwd, title: typeof p.title === "string" ? p.title : undefined, ...(typeof p.callingSessionId === "string" && p.callingSessionId ? { extra: { callingSessionId: p.callingSessionId } } : {}) });
          session = build(id, sessionCwd, settings, p, env, pick<ToolExecutionMode>(p.toolExecutionMode, EXEC_MODES, "toolExecutionMode"));
          if (worktree) updateSessionSettings(files, { worktree: worktreeSettings(worktree) });
          if (typeof p.environment === "string" && p.environment) updateSessionSettings(files, { environment: p.environment }); // the name only, never values
          await session.persistSettings();
        } catch (e) {
          if (worktree) await discardSessionWorktree(worktree);
          throw e;
        }
        session.start("startup");
        notify({ type: "settings_updated", settings: session.settingsSnapshot() });
        if (handoff) session.addUserMessage(handoffBrief(handoff));
        const setup = worktree ? await runSessionSetup(worktree, notify) : undefined;
        return {
          ...sessionResult(), availableModels: listModelInfo(env.models), trusted: env.trusted,
          ...(worktree ? { worktree: { ...worktreeSettings(worktree), cwd: sessionCwd, ...(setup ? { setup } : {}) } } : {}),
        };
      }
      case "load_session": {
        if (session) throw new RpcError(ErrorCodes.CONFLICT, "This connection already has a session");
        const id = p.sessionId;
        if (!isValidSessionId(id)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid sessionId");
        const page = pageFrom(p);
        const owned = opts.sharedSession?.(id);
        if (owned) {
          session = owned.session; shared = owned;
          files = findSession(id, session.cwd) ?? undefined;
          unsubscribeShared = owned.subscribe(notify);
          const env = environment(session.cwd);
          return { ...sessionResult(page), cwd: session.cwd, isAgentLoopInProgress: session.isRunning,
            workingState: session.workingState, tokenUsage: session.tokenUsage, availableModels: listModelInfo(env.models),
            trusted: env.trusted, ...pendingLists(session) };
        }
        // A session kept alive for a client that went away: adopt it. Its open prompts are listed below; answering
        // one (rigwell.answer_request) resolves the wait the agent is still in.
        let live = parked.get(id);
        if (live && remoteMember) {
          // Reconnecting owners need fresh admission/usage hooks bound to their SSH channel.
          clearTimeout(live.timer); parked.delete(id); live.session.interrupt(true);
          await live.session.idle(); await live.session.stopBackgroundJobs(); await live.session.end("other"); live.worktree?.release();
          live = undefined;
        }
        if (live) {
          clearTimeout(live.timer);
          parked.delete(id);
          session = live.session;
          files = live.files;
          // The parked session kept its worktree hold; the new connection owns it now (released on close/shutdown).
          worktree = live.worktree;
          session.setHost(hostFor());
          const lenv = environment(session.cwd);
          notify({ type: "settings_updated", settings: session.settingsSnapshot() });
          return {
            ...sessionResult(page), cwd: session.cwd, isAgentLoopInProgress: session.isRunning, workingState: session.workingState,
            tokenUsage: session.tokenUsage, availableModels: listModelInfo(lenv.models), ...pendingLists(session),
          };
        }
        const found = findSession(id, typeof p.cwd === "string" ? p.cwd : process.cwd());
        if (!found) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `Session not found: ${id}`);
        files = found;
        const loaded = loadTranscript(found);
        const cwd = loaded.start.cwd;
        const { view, archived } = applyCompaction(loaded.messages, loaded.compaction);
        const saved = readSessionSettings(found) ?? {};
        await resolveTrust(cwd);
        const env = environment(cwd);
        const merged = { ...savedParams(saved), ...p };
        toolIdsFrom(merged); systemPromptFrom(merged); outputFormatFrom(merged.structuredOutputFormat, "structuredOutputFormat");
        const settings: SessionSettings = {
          modelId: opts.forced?.modelId ?? (saved.model as string) ?? env.models[0]?.id,
          reasoningEffort: (saved.reasoningEffort as ReasoningEffort) ?? "high",
          interactionMode: (saved.interactionMode as InteractionMode) ?? "auto",
          autonomyLevel: opts.forced?.autonomyLevel ?? (saved.autonomyLevel as AutonomyLevel) ?? "off",
          ...(typeof saved.compactionModelId === "string" ? { compactionModelId: saved.compactionModelId } : {}),
          ...(typeof saved.specModeModelId === "string" ? { specModeModelId: saved.specModeModelId } : {}),
          ...(typeof saved.specModeReasoningEffort === "string" ? { specModeReasoningEffort: saved.specModeReasoningEffort as ReasoningEffort } : {}),
        };
        const savedOverride = EXEC_MODES.includes(saved.toolExecutionModeOverride as string) ? (saved.toolExecutionModeOverride as ToolExecutionMode) : undefined;
        session = build(id, cwd, settings, merged, env, savedOverride, {
          previousSessionId: typeof loaded.start.parent === "string" ? loaded.start.parent : id,
          callingSessionId: typeof loaded.start.callingSessionId === "string" ? loaded.start.callingSessionId : undefined,
          todos: loaded.todos, title: { value: loaded.start.title, manual: loaded.start.isSessionTitleManuallySet === true },
          allowSubagentsInScripts: saved.allowSubagentsInScripts === true || p.allowSubagentsInScripts === true || undefined,
          messages: view, archived, anchor: loaded.compaction?.anchorMessage.id, tokenUsage: saved.tokenUsage,
          deferred: {
            loaded: [...new Set([
              ...(Array.isArray(saved.loadedDeferredToolNames) ? (saved.loadedDeferredToolNames as string[]) : []),
              ...(loaded.compaction?.loadedDeferredToolNames ?? []),
            ])],
            announced: Array.isArray(saved.announcedDeferredToolNames) ? (saved.announcedDeferredToolNames as string[]) : [],
          },
        });
        if (typeof saved.providerLock === "string") session.providerLock = saved.providerLock;
        try { worktree = await startSessionWorktree(false, cwd, id, env.s, opts.log) ?? undefined; }
        catch (e) { await session.end("other"); session = undefined; throw e; }
        session.start("resume");
        return {
          ...sessionResult(page), cwd, isAgentLoopInProgress: false, workingState: "idle",
          tokenUsage: session.tokenUsage, availableModels: listModelInfo(env.models),
          trusted: env.trusted, updatedAt: Math.floor(Date.now() / 1000), ...pendingLists(session),
        };
      }
      case "add_user_message": {
        const s = need();
        const um = userMessageFrom(p);
        s.addUserMessage(um.text, typeof p.messageId === "string" ? p.messageId : undefined, typeof p.userMessageSource === "string" ? p.userMessageSource : undefined, {
          content: um.content, placement: um.placement, outputFormat: um.outputFormat,
        });
        return {};
      }
      case "settle_session": {
        await need().settled();
        return {};
      }
      case "answer_request": {
        // The reconnecting client answers a re-shown prompt (load_session pendingPermissions / pendingAskUserRequests).
        const s = need();
        if (typeof p.requestId !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "requestId is required");
        const answer = (p.answer ?? { selectedOption: p.selectedOption, comment: p.comment, editedSpecContent: p.editedSpecContent, clientStartsHandoffSession: p.clientStartsHandoffSession, specHandoffId: p.specHandoffId, cancelled: p.cancelled, answers: p.answers }) as unknown;
        if (!s.answerPrompt(p.requestId, answer)) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `No open request ${p.requestId}`);
        return {};
      }
      case "rename_session": {
        const s = need();
        if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 300) throw new RpcError(ErrorCodes.INVALID_PARAMS, "title must be a non-empty string of at most 300 characters");
        await s.setTitle(p.title.trim(), true);
        return {};
      }
      case "pin_session": {
        need();
        if (typeof p.pinned !== "boolean") throw new RpcError(ErrorCodes.INVALID_PARAMS, "pinned must be a boolean");
        updateSessionSettings(files!, { pinned: p.pinned });
        return {};
      }
      case "archive_session": {
        const s = need();
        if (typeof p.archived !== "boolean") throw new RpcError(ErrorCodes.INVALID_PARAMS, "archived must be a boolean");
        updateSessionSettings(files!, { archivedAt: p.archived ? new Date().toISOString() : null });
        if (p.archived) void onSessionArchived(s.id, undefined, opts.log).catch(() => {});
        return {};
      }
      case "list_sessions": {
        const limit = typeof p.limit === "number" && p.limit > 0 ? Math.floor(p.limit) : undefined;
        const local = listSessionEntries({ cwd: typeof p.cwd === "string" ? resolve(p.cwd) : undefined, includeArchived: p.includeArchived === true, includeBtwForks: p.includeBtwForks === true });
        const remote = new RemoteSessionStore().list().filter((r) => !r.isSubagent && (!p.cwd || r.cwd === p.cwd) && (p.includeArchived === true || !r.archivedAt) && r.hasUserVisibleMessages);
        const rows = [...local, ...remote].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
        return { sessions: limit ? rows.slice(0, limit) : rows };
      }
      case "search_sessions": {
        if (typeof p.query !== "string" || !p.query.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "query must be a non-empty string");
        if (p.mode !== undefined && p.mode !== "lexical" && p.mode !== "semantic") throw new RpcError(ErrorCodes.INVALID_PARAMS, "mode must be lexical or semantic");
        return { hits: await searchSessions(p.query, p.mode ?? "lexical", { cwd: typeof p.cwd === "string" ? resolve(p.cwd) : undefined, includeArchived: p.includeArchived === true, limit: typeof p.limit === "number" ? p.limit : undefined }) };
      }
      case "interrupt_session": need().interrupt(p.discardQueuedMessages === true); return {};
      case "close_session": {
        remoteMember?.close();
        if (shared) { unsubscribeShared?.(); unsubscribeShared = undefined; closed = true; return {}; }
        if (session) {
          session.interrupt(true);
          await session.idle();
          await session.stopBackgroundJobs();
          await session.end(typeof p.reason === "string" ? p.reason : "other");
          notify({ type: "agent_working_state_changed", newState: "idle", backgroundWork: session.backgroundWork() });
        }
        worktree?.release();
        closed = true;
        return {};
      }
      case "update_session_settings": {
        const s = need();
        const patch: Partial<SessionSettings> = {
          modelId: p.modelId as string | undefined,
          reasoningEffort: pick<ReasoningEffort>(p.reasoningEffort, EFFORTS, "reasoningEffort"),
          interactionMode: pick<InteractionMode>(p.interactionMode, MODES, "interactionMode"),
          autonomyLevel: pick<AutonomyLevel>(p.autonomyLevel, AUTONOMY, "autonomyLevel"),
        };
        if (patch.modelId !== undefined && !modelOk(environment(s.cwd), patch.modelId)) {
          throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown model: ${patch.modelId}`);
        }
        if (p.compactionModelId !== undefined) {
          const cm = p.compactionModelId;
          if (cm !== null && (typeof cm !== "string" || !findModel(environment(s.cwd).models, cm))) {
            throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown compaction model: ${JSON.stringify(cm)}`);
          }
          patch.compactionModelId = cm === null ? undefined : (cm as string);
          if (cm === null) s.settings.compactionModelId = undefined;
        }
        if (p.missionSettings && typeof p.missionSettings === "object" && files) updateSessionSettings(files, { missionSettings: p.missionSettings });
        for (const k of ["specModeModelId", "specModeReasoningEffort"] as const) {
          const v = p[k];
          if (v === undefined) continue;
          if (v !== null && typeof v !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid ${k}: ${JSON.stringify(v)}`);
          if (k === "specModeModelId" && v !== null && !modelOk(environment(s.cwd), v as string)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown model: ${v}`);
          if (k === "specModeReasoningEffort" && v !== null) pick<ReasoningEffort>(v, EFFORTS, k);
          if (v === null) s.settings[k] = undefined; else (patch as any)[k] = v;
        }
        if (p.compactionTokenLimit !== undefined || p.compactionThresholdCheckEnabled !== undefined) {
          if (p.compactionTokenLimit !== undefined && p.compactionTokenLimit !== null && (typeof p.compactionTokenLimit !== "number" || p.compactionTokenLimit <= 0)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "compactionTokenLimit must be a positive number");
          s.setCompaction({ limit: p.compactionTokenLimit as number | null | undefined, checkEnabled: typeof p.compactionThresholdCheckEnabled === "boolean" ? p.compactionThresholdCheckEnabled : undefined });
        }
        s.updateSettings(patch);
        if (p.tags !== undefined) s.setTags(tagsFrom(p.tags) ?? []);
        const idUpdates = toolIdUpdates(p);
        if (idUpdates) s.setToolIds(idUpdates);
        return {};
      }
      case "compact_session": {
        const s = need();
        if (p.mode !== undefined && p.mode !== "handoff") throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid mode: ${JSON.stringify(p.mode)}`);
        try {
          return await s.compactManual({ customInstructions: typeof p.customInstructions === "string" ? p.customInstructions : undefined, mode: p.mode as "handoff" | undefined });
        } catch (e) {
          if (e instanceof SessionBusyError) throw new RpcError(ErrorCodes.CONFLICT, e.message);
          throw new RpcError(ErrorCodes.INTERNAL_ERROR, `Compaction failed: ${(e as Error).message}`);
        }
      }
      case "list_mcp_servers": return need().listMcpServers();
      case "mcp_catalog_list": {
        try { return await need().listMcpCatalog(p.sources); } catch (e) { throw new RpcError(ErrorCodes.INVALID_PARAMS, (e as Error).message); }
      }
      case "mcp_catalog_add": {
        if (typeof p.key !== "string" || (p.name !== undefined && typeof p.name !== "string")) throw new RpcError(ErrorCodes.INVALID_PARAMS, "key and optional name must be strings");
        try { return await need().addMcpCatalog(p.key, p.values as Record<string, string> | undefined, p.name as string | undefined); } catch (e) { throw new RpcError(ErrorCodes.INVALID_PARAMS, (e as Error).message); }
      }
      case "mcp_sign_in":
      case "mcp_sign_out":
      case "mcp_sign_in_status":
      case "mcp_sign_in_cancel": {
        const s = need();
        if (typeof p.name !== "string" || !p.name) throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
        if ((method === "mcp_sign_in_status" || method === "mcp_sign_in_cancel") && typeof p.loginId !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "loginId is required");
        try {
          if (method === "mcp_sign_in") return await s.signInMcp(p.name);
          if (method === "mcp_sign_out") return await s.signOutMcp(p.name);
          if (method === "mcp_sign_in_cancel") return s.cancelMcpLogin(p.name, p.loginId as string);
          return s.mcpLoginStatus(p.name, p.loginId as string);
        } catch (e) { throw new RpcError(ErrorCodes.INVALID_PARAMS, (e as Error).message); }
      }
      case "add_mcp_server": {
        const s = need();
        try { return await s.addMcpServer(p as any); } catch (e) { throw new RpcError(ErrorCodes.INVALID_PARAMS, (e as Error).message); }
      }
      case "remove_mcp_server": {
        const s = need();
        if (typeof p.serverName !== "string" || !p.serverName) throw new RpcError(ErrorCodes.INVALID_PARAMS, "serverName is required");
        if (p.settingsLevel !== undefined && p.settingsLevel !== "user") throw new RpcError(ErrorCodes.INVALID_PARAMS, 'settingsLevel must be "user"');
        try { return await s.removeMcpServer(p.serverName, "user"); } catch (e) { throw new RpcError(ErrorCodes.INVALID_PARAMS, (e as Error).message); }
      }
      case "fork_session": {
        const s = need();
        if (s.isRunning) throw new RpcError(ErrorCodes.CONFLICT, "A turn is running; wait for it to finish before forking.");
        if (p.title !== undefined && typeof p.title !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "title must be a string");
        const tags = Array.isArray(p.tags) ? (p.tags as any[]).filter((t) => t && typeof t.name === "string") : undefined;
        const dest = forkSession(files!, { title: p.title as string | undefined, tags });
        return { newSessionId: dest.id };
      }
      case "rewind_session": {
        const s = need();
        if (typeof p.messageId !== "string" || !p.messageId) throw new RpcError(ErrorCodes.INVALID_PARAMS, "messageId is required");
        try {
          return await rewindSession({ session: s, messageId: p.messageId, restoreFiles: p.restoreFiles === true, force: p.force === true });
        } catch (e) {
          if (!(e instanceof RewindError)) throw e;
          const code = e.code === "not_found" ? ErrorCodes.ENTITY_NOT_FOUND
            : e.code === "busy" || e.code === "stale" ? ErrorCodes.CONFLICT : ErrorCodes.INVALID_PARAMS;
          throw new RpcError(code, e.message, { reason: e.code, ...(e.files ? { files: e.files } : {}) });
        }
      }
      case "list_tools": {
        const s = need();
        const ids = toolIdsFrom(p);
        const lenv = environment(s.cwd);
        for (const k of ["modelId", "specModeModelId"] as const) {
          if (p[k] !== undefined && (typeof p[k] !== "string" || !modelOk(lenv, p[k] as string))) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown model: ${JSON.stringify(p[k])}`);
        }
        if (p.depth !== undefined && (typeof p.depth !== "number" || !Number.isInteger(p.depth) || p.depth < 0)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "depth must be an integer of 0 or more");
        let all = s.listToolInfo({
          modelId: p.modelId as string | undefined, specModeModelId: p.specModeModelId as string | undefined,
          interactionMode: pick<InteractionMode>(p.interactionMode, MODES, "interactionMode"), autonomyLevel: pick<AutonomyLevel>(p.autonomyLevel, AUTONOMY, "autonomyLevel"),
          skipPermissions: p.skipPermissionsUnsafe === true ? true : undefined, depth: p.depth as number | undefined, toolIds: ids,
        });
        if (Array.isArray(p.toolIds)) all = all.filter((t) => (p.toolIds as unknown[]).includes(t.tool.name));
        return {
          tools: all.map(({ tool: t, currentlyAllowed, source }) => ({
            id: t.name, llmId: t.name, displayName: t.name, description: t.description, category: t.category,
            defaultAllowed: t.category === "read", currentlyAllowed, source,
            ...(p.includeSchemas ? { schemas: { input: t.inputSchema } } : {}),
          })),
        };
      }
      case "list_models": {
        const cwd = session?.cwd ?? process.cwd();
        const menv = environment(cwd);
        const models: object[] = [...listModelInfo(menv.models)];
        if (p.includeDisabled === true) {
          // Entries that did not validate show up disabled, with the reason.
          for (const pr of validateCustomModels(menv.s).problems) {
            models.push({ id: `custom:${pr.model ?? "invalid"}-${pr.index}`, displayName: pr.model ?? `Custom model ${pr.index + 1}`, shortDisplayName: pr.model ?? `Custom model ${pr.index + 1}`, isCustom: true, disabled: true, disabledReason: pr.message });
          }
        }
        return { models };
      }
      case "get_context_stats": {
        const s = need();
        const model = findModel(environment(s.cwd).models, s.settings.modelId);
        return s.contextStats(model?.maxContextLimit ?? 200_000);
      }
      case "warmup_cache": {
        await need().warmupCache();
        return {};
      }
      default: {
        if (opts.extraMethods?.[method]) return opts.extraMethods[method](p);
        if (["review_snapshot", "review_task", "review_submit"].includes(method)) {
          reviews ??= new (await import("../review/service.ts")).ReviewService({ cwd: () => session?.cwd ?? process.cwd(), approve: opts.canPrompt ? hostFor().requestPermission : undefined, host: opts.reviewHostDeps });
          return reviews.handle(method, p);
        }
        const w = await handleWorktreeMethod(method, p, { cwd: session?.cwd, settings: () => environment(session?.cwd ?? process.cwd()).s, log: opts.log, requestPermission: hostFor().requestPermission });
        if (w.handled) return w.result;
        const a = await handleAuthMethod(method, p, () => environment(session?.cwd ?? process.cwd()).s);
        if (a.handled) return a.result;
        const cp = await handleCodeProviderMethod(method, p, () => environment(session?.cwd ?? process.cwd()).s, opts.codeProviderDeps);
        if (cp.handled) return cp.result;
        const sx = handleSecretsMethod(method, p);
        if (sx.handled) return sx.result;
        throw new RpcError(ErrorCodes.METHOD_NOT_FOUND, `Method not found or not in this build: ${METHOD_PREFIX}${method}`);
      }
    }
  }

  return {
    peer,
    get session() { return session; },
    get closed() { return closed; },
    async shutdown(o: { park?: boolean } = {}) {
      shuttingDown = true;
      remoteMember?.close();
      if (openingRemote) { try { await openingRemote; } catch {} }
      if (remote) { await remote.close(); peer.end(); return; }
      if (sharedRemote) { unsubscribeShared?.(); unsubscribeShared = undefined; peer.end(); return; }
      if (shared) { unsubscribeShared?.(); unsubscribeShared = undefined; peer.end(); return; }
      // The client went away while a prompt is open: keep the session for a reconnecting load_session.
      if (o.park && session && !closed && session.isRunning && session.pendingPrompts().length) {
        const s = session;
        const wt = worktree;
        const timer = setTimeout(() => {
          parked.delete(s.id);
          wt?.release();
          s.interrupt();
          void s.idle().then(() => s.stopBackgroundJobs()).then(() => s.end("other")).catch(() => {});
        }, parkMs());
        timer.unref?.();
        parked.set(s.id, { session: s, files: files!, worktree: wt, timer });
        peer.end();
        return;
      }
      session?.interrupt(true); await session?.idle(); await session?.stopBackgroundJobs(); await session?.end("other"); worktree?.release(); peer.end(); },
  };
}

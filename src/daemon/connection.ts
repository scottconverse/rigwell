// One client connection = one session (spec §3.1.4 default). Maps protocol methods to a Session.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AutonomyLevel, CommandLists, InteractionMode, Message, ReasoningEffort, Tool } from "../core/types.ts";
import { ErrorCodes, METHOD_PREFIX, RpcError, RpcPeer } from "../protocol/rpc.ts";
import { Session, SessionBusyError, type SessionHost, type SessionSettings } from "../agent/session.ts";
import { applyCompaction } from "../agent/compaction.ts";
import { AUTO_MODEL_ID, type RouterConfig } from "../agent/router.ts";
import { hasProjectConfig, isFolderTrusted, loadSettings, trustFolder } from "../storage/settings.ts";
import { findModel, listModelInfo, resolveModels, validateCustomModels } from "../storage/models.ts";
import { appendCompaction, appendMessage, appendTitle, appendTodoState, appendTurnOutcome, createSession, findSession, loadTranscript, type SessionFiles } from "../storage/transcript.ts";
import { listSessionEntries, searchSessions } from "../storage/session-list.ts";
import { outputFormatFrom, systemPromptFrom, tagsFrom, toolIdUpdates, toolIdsFrom, userMessageFrom } from "./params.ts";
import { gitRepoOf } from "./gitrepo.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { hostId, isValidSessionId } from "../storage/paths.ts";
import { createAdapter } from "../adapters/index.ts";
import { streamWithRetry } from "../adapters/retry.ts";
import { toolsForSession } from "../tools/registry.ts";
import { decide } from "../permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";
import { discardSessionWorktree, handleWorktreeMethod, onSessionArchived, onSessionTitleUpdated, releaseWorktree, runSessionSetup, startSessionWorktree, worktreeSettings, type SessionWorktree } from "../worktree/connect.ts";
import type { ToolExecutionMode } from "../core/types.ts";
import { HookRunner, loadHooksConfig } from "../hooks/index.ts";
import { fromInitConfigs, type McpServerInitConfig } from "../mcp/index.ts";
import { loadAgents } from "../subagents/agents.ts";
import { TaskLimits } from "../subagents/task.ts";
import { forkSession } from "../storage/fork.ts";
import { handleAuthMethod } from "../auth/methods.ts";
import { handleSecretsMethod } from "../secrets/methods.ts";
import { SecretsError, redactSecrets, resolveEnvironment, type ResolvedEnvironment } from "../secrets/store.ts";
import { RewindError, rewindSession } from "../snapshots/index.ts";
import { automationSetupParams } from "../automations/setup.ts";

/** Sessions whose client went away while a prompt was open: kept for a reconnecting load_session (spec 3.1.5 pending lists). */
const parked = new Map<string, { session: Session; files: SessionFiles; worktree?: SessionWorktree; timer: ReturnType<typeof setTimeout> }>();
const parkMs = () => Number(process.env.RIGWELL_PARK_MS) || 30 * 60_000;

export interface ConnectionOptions {
  /** The client can answer rigwell.request_permission (stream-jsonrpc). False for plain `exec "prompt"`. */
  canPrompt: boolean;
  runtimeSettingsPath?: string;
  /** Values from exec flags; they override what initialize_session asks for. */
  forced?: { autonomyLevel?: AutonomyLevel; skipPermissions?: boolean; modelId?: string };
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
  let session: Session | undefined;
  let files: SessionFiles | undefined;
  let closed = false;
  let worktree: SessionWorktree | undefined;

  const peer: RpcPeer = new RpcPeer(write, (m, p) => handle(m, p), opts.log);

  const notify = (n: Record<string, unknown>) => {
    peer.notify(METHOD_PREFIX + "session_notification", { ...(session ? { sessionId: session.id } : {}), notification: n });
    // A generated title renames a generated worktree branch (spec 18.2).
    if (n.type === "session_title_updated" && n.updateType !== "manual" && worktree && session && typeof n.title === "string") {
      void onSessionTitleUpdated(session.id, n.title, undefined, opts.log).catch(() => {});
    }
  };

  function need(): Session {
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
    const models = resolveModels(s);
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
      appendMessage: async (msg: Message, parent: string | null) => { await appendMessage(f, msg, parent); },
      appendTurnOutcome: (o: { turnId: string; reason: string; resultKind: "text" | "structured" | null }) => appendTurnOutcome(f, o),
      appendTodoState: (todos: any, idx: number) => appendTodoState(f, todos, idx),
      setTitle: async (title: string, manual: boolean) => { await appendTitle(f, title, manual); updateSessionSettings(f, { title, isSessionTitleManuallySet: manual }); },
      appendCompaction: (rec: any) => appendCompaction(f, rec),
      saveSettings: async (patch: Record<string, unknown>) => { updateSessionSettings(f, patch); },
    };
  }

  function build(id: string, cwd: string, settings: SessionSettings, p: Record<string, unknown>, env: ReturnType<typeof environment>, override: ToolExecutionMode | undefined, restored?: { previousSessionId?: string; callingSessionId?: string; allowSubagentsInScripts?: boolean; messages: Message[]; tokenUsage?: any; deferred?: { loaded: string[]; announced: string[] }; archived?: Message[]; anchor?: string; todos?: any; title?: { value: string; manual: boolean } }) {
    const skip = opts.forced?.skipPermissions ?? p.skipPermissionsUnsafe === true;
    const f = files!;
    const hooksConfig = loadHooksConfig({ cwd, trustProject: env.trusted });
    const sessionEnv = sessionEnvironment(p);
    return new Session({
      id, cwd, settings,
      ...(sessionEnv ? { extraEnv: sessionEnv.env, redact: (t: string) => redactSecrets(t, sessionEnv.secrets) } : {}),
      resolveModel: (mid) => findModel(env.models, mid),
      createAdapter, streamWithRetry: streamWithRetry as any,
      toolsFor: ((base) => (opts.wrapTools ? (o: Parameters<typeof toolsForSession>[0]) => opts.wrapTools!(base(o)) : base))(opts.extraTools ? (o: Parameters<typeof toolsForSession>[0]) => [...toolsForSession(o), ...opts.extraTools!()] : toolsForSession), decide, lists: env.lists,
      scriptToolModels: env.s.scriptToolModels, scriptLimits: env.s.scriptLimits,
      toolExecutionModeOverride: override,
      skipPermissions: skip,
      autoRejectPermissionRequests: p.autoRejectPermissionRequests === true,
      shell: SHELL, retryBaseDelayMs: opts.retryBaseDelayMs,
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
      compactionThresholdCheckEnabled: env.s.compactionThresholdCheckEnabled, router: routerOf(env),
      persistence: persistenceFor(f),
      transcriptPath: f.transcriptPath,
      hooksFor: (a) => new HookRunner({
        config: hooksConfig, sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd, permissionMode: a.permissionMode, notify: a.notify, env: sessionEnv?.env,
      }),
      mcp: { servers: fromInitConfigs(p.mcpServers as McpServerInitConfig[] | undefined) },
      allowSubagentsInScripts: restored?.allowSubagentsInScripts ?? (p.allowSubagentsInScripts === true || env.s.allowSubagentsInScripts === true),
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
    switch (method) {
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
          autonomyLevel: opts.forced?.autonomyLevel ?? pick<AutonomyLevel>(p.autonomyLevel, AUTONOMY, "autonomyLevel") ?? (d.autonomyLevel as AutonomyLevel) ?? "off",
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
        // A session kept alive for a client that went away: adopt it. Its open prompts are listed below; answering
        // one (rigwell.answer_request) resolves the wait the agent is still in.
        const live = parked.get(id);
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
      case "answer_request": {
        // The reconnecting client answers a re-shown prompt (load_session pendingPermissions / pendingAskUserRequests).
        const s = need();
        if (typeof p.requestId !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, "requestId is required");
        const answer = (p.answer ?? { selectedOption: p.selectedOption, comment: p.comment, editedSpecContent: p.editedSpecContent, cancelled: p.cancelled, answers: p.answers }) as unknown;
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
        return { sessions: listSessionEntries({ cwd: typeof p.cwd === "string" ? resolve(p.cwd) : undefined, includeArchived: p.includeArchived === true, includeBtwForks: p.includeBtwForks === true, limit }) };
      }
      case "search_sessions": {
        if (typeof p.query !== "string" || !p.query.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "query must be a non-empty string");
        if (p.mode !== undefined && p.mode !== "lexical" && p.mode !== "semantic") throw new RpcError(ErrorCodes.INVALID_PARAMS, "mode must be lexical or semantic");
        return { hits: await searchSessions(p.query, p.mode ?? "lexical", { cwd: typeof p.cwd === "string" ? resolve(p.cwd) : undefined, includeArchived: p.includeArchived === true, limit: typeof p.limit === "number" ? p.limit : undefined }) };
      }
      case "interrupt_session": need().interrupt(); return {};
      case "close_session": {
        if (session) {
          session.interrupt();
          await session.idle();
          await session.stopBackgroundJobs();
          await session.end(typeof p.reason === "string" ? p.reason : "other");
          notify({ type: "agent_working_state_changed", newState: "idle", backgroundWork: session.backgroundWork() });
        }
        if (worktree) releaseWorktree(worktree.info.path);
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
        const w = await handleWorktreeMethod(method, p, { cwd: session?.cwd, settings: () => environment(session?.cwd ?? process.cwd()).s, log: opts.log });
        if (w.handled) return w.result;
        const a = await handleAuthMethod(method, p, () => environment(session?.cwd ?? process.cwd()).s);
        if (a.handled) return a.result;
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
      // The client went away while a prompt is open: keep the session for a reconnecting load_session.
      if (o.park && session && !closed && session.isRunning && session.pendingPrompts().length) {
        const s = session;
        const wt = worktree;
        const timer = setTimeout(() => {
          parked.delete(s.id);
          if (wt) releaseWorktree(wt.info.path);
          s.interrupt();
          void s.idle().then(() => s.stopBackgroundJobs()).then(() => s.end("other")).catch(() => {});
        }, parkMs());
        timer.unref?.();
        parked.set(s.id, { session: s, files: files!, worktree: wt, timer });
        peer.end();
        return;
      }
      session?.interrupt(); await session?.idle(); await session?.stopBackgroundJobs(); await session?.end("other"); if (worktree) releaseWorktree(worktree.info.path); peer.end(); },
  };
}

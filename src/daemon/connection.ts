// One client connection = one session (spec §3.1.4 default). Maps protocol methods to a Session.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AutonomyLevel, CommandLists, InteractionMode, Message, ReasoningEffort } from "../core/types.ts";
import { ErrorCodes, METHOD_PREFIX, RpcError, RpcPeer } from "../protocol/rpc.ts";
import { Session, SessionBusyError, type SessionSettings } from "../agent/session.ts";
import { applyCompaction } from "../agent/compaction.ts";
import { AUTO_MODEL_ID, type RouterConfig } from "../agent/router.ts";
import { loadSettings } from "../storage/settings.ts";
import { findModel, listModelInfo, resolveModels } from "../storage/models.ts";
import { appendCompaction, appendMessage, appendTurnOutcome, createSession, findSession, loadTranscript, type SessionFiles } from "../storage/transcript.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { hostId, isValidSessionId } from "../storage/paths.ts";
import { createAdapter } from "../adapters/index.ts";
import { streamWithRetry } from "../adapters/retry.ts";
import { toolsForSession } from "../tools/registry.ts";
import { decide } from "../permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";
import { discardSessionWorktree, handleWorktreeMethod, releaseWorktree, runSessionSetup, startSessionWorktree, worktreeSettings, type SessionWorktree } from "../worktree/connect.ts";
import type { ToolExecutionMode } from "../core/types.ts";
import { HookRunner, loadHooksConfig } from "../hooks/index.ts";
import { fromInitConfigs, type McpServerInitConfig } from "../mcp/index.ts";
import { loadAgents } from "../subagents/agents.ts";
import { TaskLimits } from "../subagents/task.ts";
import { forkSession } from "../storage/fork.ts";

export interface ConnectionOptions {
  /** The client can answer rigwell.request_permission (stream-jsonrpc). False for plain `exec "prompt"`. */
  canPrompt: boolean;
  runtimeSettingsPath?: string;
  /** Values from exec flags; they override what initialize_session asks for. */
  forced?: { autonomyLevel?: AutonomyLevel; skipPermissions?: boolean; modelId?: string };
  retryBaseDelayMs?: number;
  /** Extra protocol methods (name without the prefix), e.g. the daemon's automation methods. */
  extraMethods?: Record<string, (p: Record<string, unknown>) => unknown>;
  log?: (m: string) => void;
}

const AUTONOMY = ["off", "low", "medium", "high"];
const MODES = ["auto", "spec"];
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

  const notify = (n: Record<string, unknown>) =>
    peer.notify(METHOD_PREFIX + "session_notification", { ...(session ? { sessionId: session.id } : {}), notification: n });

  function need(): Session {
    if (!session) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "No session: call initialize_session or load_session first");
    return session;
  }

  function environment(cwd: string) {
    const loaded = loadSettings({ cwd, runtimeSettingsPath: opts.runtimeSettingsPath });
    for (const w of loaded.warnings) opts.log?.(`[settings] ${w}`);
    const s = loaded.settings;
    const models = resolveModels(s);
    const lists: CommandLists = {
      allow: s.commandAllowlist ?? DEFAULT_COMMAND_LISTS.allow,
      deny: s.commandDenylist ?? DEFAULT_COMMAND_LISTS.deny,
      block: s.commandBlocklist ?? DEFAULT_COMMAND_LISTS.block,
    };
    return { s, models, lists };
  }

  function routerOf(env: ReturnType<typeof environment>): RouterConfig | undefined {
    const r = env.s.autoRouter as RouterConfig | undefined;
    return r && Array.isArray(r.candidates) && r.candidates.length && typeof r.classifierModel === "string" ? r : undefined;
  }

  const modelOk = (env: ReturnType<typeof environment>, id: string) => !!findModel(env.models, id) || (id === AUTO_MODEL_ID && !!routerOf(env));

  function persistenceFor(f: SessionFiles) {
    return {
      appendMessage: async (msg: Message, parent: string | null) => { await appendMessage(f, msg, parent); },
      appendTurnOutcome: (o: { turnId: string; reason: string; resultKind: "text" | null }) => appendTurnOutcome(f, o),
      appendCompaction: (rec: any) => appendCompaction(f, rec),
      saveSettings: async (patch: Record<string, unknown>) => { updateSessionSettings(f, patch); },
    };
  }

  function build(id: string, cwd: string, settings: SessionSettings, p: Record<string, unknown>, env: ReturnType<typeof environment>, override: ToolExecutionMode | undefined, restored?: { allowSubagentsInScripts?: boolean; messages: Message[]; tokenUsage?: any; deferred?: { loaded: string[]; announced: string[] }; archived?: Message[]; anchor?: string }) {
    const skip = opts.forced?.skipPermissions ?? p.skipPermissionsUnsafe === true;
    const f = files!;
    const hooksConfig = loadHooksConfig({ cwd });
    return new Session({
      id, cwd, settings,
      resolveModel: (mid) => findModel(env.models, mid),
      createAdapter, streamWithRetry: streamWithRetry as any,
      toolsFor: toolsForSession, decide, lists: env.lists,
      scriptToolModels: env.s.scriptToolModels, scriptLimits: env.s.scriptLimits,
      toolExecutionModeOverride: override,
      skipPermissions: skip,
      autoRejectPermissionRequests: p.autoRejectPermissionRequests === true,
      shell: SHELL, retryBaseDelayMs: opts.retryBaseDelayMs,
      messages: restored?.messages, tokenUsage: restored?.tokenUsage, deferred: restored?.deferred, log: opts.log,
      archived: restored?.archived, compactionAnchorId: restored?.anchor,
      guardSettings: { llmRequestTimeout: env.s.llmRequestTimeout as number | undefined, loopGuards: env.s.loopGuards as any },
      compaction: env.s.compaction as any, compactionTokenLimit: env.s.compactionTokenLimit,
      compactionThresholdCheckEnabled: env.s.compactionThresholdCheckEnabled, router: routerOf(env),
      persistence: persistenceFor(f),
      transcriptPath: f.transcriptPath,
      hooksFor: (a) => new HookRunner({
        config: hooksConfig, sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd, permissionMode: a.permissionMode, notify: a.notify,
      }),
      mcp: { servers: fromInitConfigs(p.mcpServers as McpServerInitConfig[] | undefined) },
      allowSubagentsInScripts: restored?.allowSubagentsInScripts ?? (p.allowSubagentsInScripts === true || env.s.allowSubagentsInScripts === true),
      specSaveDir: typeof env.s.specSaveDir === "string" ? env.s.specSaveDir : undefined,
      subagents: {
        limits: limitsFor(env.s), depth: 0, rootSessionId: id,
        agents: loadAgents({ cwd, isValidModel: (m) => !!findModel(env.models, m) }).agents,
        openChild: (o) => {
          const cf = createSession({ id: o.id, cwd: o.cwd, title: o.title, extra: { callingSessionId: o.callingSessionId, callingToolUseId: o.callingToolUseId } });
          updateSessionSettings(cf, { tags: [{ name: "subagent", metadata: { subagent: 1, depth: o.depth, ...(o.agentName ? { agent: o.agentName } : {}) } }] });
          return { persistence: persistenceFor(cf), transcriptPath: cf.transcriptPath };
        },
      },
    }, {
      notify,
      requestPermission: opts.canPrompt
        ? async (params) => (await peer.request(METHOD_PREFIX + "request_permission", params)) as any
        : undefined,
    });
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

  function sessionResult() {
    const s = need();
    return {
      sessionId: s.id, hostId: hostId(),
      session: { messages: s.uiMessages().filter((m) => m.visibility !== "llm_only") },
      settings: s.settingsSnapshot(),
    };
  }

  async function handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize_session": {
        if (session) throw new RpcError(ErrorCodes.CONFLICT, "This connection already has a session");
        if (typeof p.cwd !== "string" || !p.cwd) throw new RpcError(ErrorCodes.INVALID_PARAMS, "cwd is required");
        const cwd = resolve(p.cwd);
        if (!existsSync(cwd)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `cwd does not exist: ${cwd}`);
        const id = p.sessionId === undefined ? crypto.randomUUID() : String(p.sessionId);
        if (!isValidSessionId(id)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid sessionId");
        if (findSession(id, cwd)) throw new RpcError(ErrorCodes.CONFLICT, `Session ${id} already exists; use load_session`);
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
          files = createSession({ id, cwd: sessionCwd, title: typeof p.title === "string" ? p.title : undefined });
          session = build(id, sessionCwd, settings, p, env, pick<ToolExecutionMode>(p.toolExecutionMode, EXEC_MODES, "toolExecutionMode"));
          if (worktree) updateSessionSettings(files, { worktree: worktreeSettings(worktree) });
          await session.persistSettings();
        } catch (e) {
          if (worktree) await discardSessionWorktree(worktree);
          throw e;
        }
        session.start("startup");
        notify({ type: "settings_updated", settings: session.settingsSnapshot() });
        const setup = worktree ? await runSessionSetup(worktree, notify) : undefined;
        return {
          ...sessionResult(), availableModels: listModelInfo(env.models),
          ...(worktree ? { worktree: { ...worktreeSettings(worktree), cwd: sessionCwd, ...(setup ? { setup } : {}) } } : {}),
        };
      }
      case "load_session": {
        if (session) throw new RpcError(ErrorCodes.CONFLICT, "This connection already has a session");
        const id = p.sessionId;
        if (!isValidSessionId(id)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Invalid sessionId");
        const found = findSession(id, typeof p.cwd === "string" ? p.cwd : process.cwd());
        if (!found) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `Session not found: ${id}`);
        files = found;
        const loaded = loadTranscript(found);
        const cwd = loaded.start.cwd;
        const { view, archived } = applyCompaction(loaded.messages, loaded.compaction);
        const saved = readSessionSettings(found) ?? {};
        const env = environment(cwd);
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
        session = build(id, cwd, settings, p, env, savedOverride, {
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
          ...sessionResult(), cwd, isAgentLoopInProgress: false, workingState: "idle",
          tokenUsage: session.tokenUsage, availableModels: listModelInfo(env.models),
          pendingPermissions: [], pendingAskUserRequests: [], pendingPickOptionsRequests: [], queuedMessages: [],
        };
      }
      case "add_user_message": {
        const s = need();
        if (typeof p.text !== "string" || !p.text.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, "text is required");
        s.addUserMessage(p.text, typeof p.messageId === "string" ? p.messageId : undefined);
        return {};
      }
      case "interrupt_session": need().interrupt(); return {};
      case "close_session": {
        if (session) {
          session.interrupt();
          await session.idle();
          await session.stopBackgroundJobs();
          await session.end(typeof p.reason === "string" ? p.reason : "other");
          notify({ type: "agent_working_state_changed", newState: "idle" });
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
        for (const k of ["specModeModelId", "specModeReasoningEffort"] as const) {
          const v = p[k];
          if (v === undefined) continue;
          if (v !== null && typeof v !== "string") throw new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid ${k}: ${JSON.stringify(v)}`);
          if (k === "specModeModelId" && v !== null && !modelOk(environment(s.cwd), v as string)) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown model: ${v}`);
          if (k === "specModeReasoningEffort" && v !== null) pick<ReasoningEffort>(v, EFFORTS, k);
          if (v === null) s.settings[k] = undefined; else (patch as any)[k] = v;
        }
        s.updateSettings(patch);
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
      case "list_tools": {
        const s = need();
        const all = s.tools();
        return {
          tools: all.map((t) => ({
            id: t.name, llmId: t.name, displayName: t.name, description: t.description, category: t.category,
            defaultAllowed: t.category === "read", currentlyAllowed: true, source: "native",
            ...(p.includeSchemas ? { schemas: { input: t.inputSchema } } : {}),
          })),
        };
      }
      case "list_models": {
        const cwd = session?.cwd ?? process.cwd();
        return { models: listModelInfo(environment(cwd).models) };
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
        throw new RpcError(ErrorCodes.METHOD_NOT_FOUND, `Method not found or not in this build: ${METHOD_PREFIX}${method}`);
      }
    }
  }

  return {
    peer,
    get session() { return session; },
    get closed() { return closed; },
    async shutdown() { session?.interrupt(); await session?.idle(); await session?.stopBackgroundJobs(); await session?.end("other"); if (worktree) releaseWorktree(worktree.info.path); peer.end(); },
  };
}

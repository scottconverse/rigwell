// One client connection = one session (spec §3.1.4 default). Maps protocol methods to a Session.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AutonomyLevel, CommandLists, InteractionMode, Message, ReasoningEffort, Tool } from "../core/types.ts";
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

  function build(id: string, cwd: string, settings: SessionSettings, p: Record<string, unknown>, env: ReturnType<typeof environment>, override: ToolExecutionMode | undefined, restored?: { messages: Message[]; tokenUsage?: any; deferred?: { loaded: string[]; announced: string[] }; archived?: Message[]; anchor?: string }) {
    const skip = opts.forced?.skipPermissions ?? p.skipPermissionsUnsafe === true;
    const f = files!;
    return new Session({
      id, cwd, settings,
      resolveModel: (mid) => findModel(env.models, mid),
      createAdapter, streamWithRetry: streamWithRetry as any,
      toolsFor: opts.extraTools ? (o) => [...toolsForSession(o), ...opts.extraTools!()] : toolsForSession, decide, lists: env.lists,
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
      persistence: {
        appendMessage: async (msg, parent) => { await appendMessage(f, msg, parent); },
        appendTurnOutcome: (o) => appendTurnOutcome(f, o),
        appendCompaction: (rec) => appendCompaction(f, rec),
        saveSettings: async (patch) => { updateSessionSettings(f, patch); },
      },
    }, {
      notify,
      requestPermission: opts.canPrompt
        ? async (params) => (await peer.request(METHOD_PREFIX + "request_permission", params)) as any
        : undefined,
    });
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
        };
        const savedOverride = EXEC_MODES.includes(saved.toolExecutionModeOverride as string) ? (saved.toolExecutionModeOverride as ToolExecutionMode) : undefined;
        session = build(id, cwd, settings, p, env, savedOverride, {
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
    async shutdown() { session?.interrupt(); await session?.idle(); await session?.stopBackgroundJobs(); if (worktree) releaseWorktree(worktree.info.path); peer.end(); },
  };
}

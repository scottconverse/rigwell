// One client connection = one session (spec §3.1.4 default). Maps protocol methods to a Session.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AutonomyLevel, CommandLists, InteractionMode, Message, ReasoningEffort } from "../core/types.ts";
import { ErrorCodes, METHOD_PREFIX, RpcError, RpcPeer } from "../protocol/rpc.ts";
import { Session, type SessionSettings } from "../agent/session.ts";
import { loadSettings } from "../storage/settings.ts";
import { findModel, listModelInfo, resolveModels } from "../storage/models.ts";
import { appendMessage, appendTurnOutcome, createSession, findSession, loadTranscript, type SessionFiles } from "../storage/transcript.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { hostId, isValidSessionId } from "../storage/paths.ts";
import { createAdapter } from "../adapters/index.ts";
import { streamWithRetry } from "../adapters/retry.ts";
import { toolsForSession } from "../tools/registry.ts";
import { decide } from "../permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";

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

  function build(id: string, cwd: string, settings: SessionSettings, p: Record<string, unknown>, env: ReturnType<typeof environment>, restored?: { messages: Message[]; tokenUsage?: any }) {
    const skip = opts.forced?.skipPermissions ?? p.skipPermissionsUnsafe === true;
    const f = files!;
    return new Session({
      id, cwd, settings,
      resolveModel: (mid) => findModel(env.models, mid),
      createAdapter, streamWithRetry: streamWithRetry as any,
      toolsFor: toolsForSession, decide, lists: env.lists,
      skipPermissions: skip,
      autoRejectPermissionRequests: p.autoRejectPermissionRequests === true,
      shell: SHELL, retryBaseDelayMs: opts.retryBaseDelayMs,
      messages: restored?.messages, tokenUsage: restored?.tokenUsage,
      persistence: {
        appendMessage: async (msg, parent) => { await appendMessage(f, msg, parent); },
        appendTurnOutcome: (o) => appendTurnOutcome(f, o),
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
      session: { messages: s.messages.filter((m) => m.visibility !== "llm_only") },
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
        if (!modelId || !findModel(env.models, modelId)) {
          throw new RpcError(ErrorCodes.INVALID_PARAMS, modelId ? `Unknown model: ${modelId}` : "No models configured: add customModels to settings.json");
        }
        const settings: SessionSettings = {
          modelId,
          reasoningEffort: pick<ReasoningEffort>(p.reasoningEffort, EFFORTS, "reasoningEffort") ?? (d.reasoningEffort as ReasoningEffort) ?? "high",
          interactionMode: pick<InteractionMode>(p.interactionMode, MODES, "interactionMode") ?? (d.interactionMode as InteractionMode) ?? "auto",
          autonomyLevel: opts.forced?.autonomyLevel ?? pick<AutonomyLevel>(p.autonomyLevel, AUTONOMY, "autonomyLevel") ?? (d.autonomyLevel as AutonomyLevel) ?? "off",
        };
        files = createSession({ id, cwd, title: typeof p.title === "string" ? p.title : undefined });
        session = build(id, cwd, settings, p, env);
        await session.persistSettings();
        notify({ type: "settings_updated", settings: session.settingsSnapshot() });
        return { ...sessionResult(), availableModels: listModelInfo(env.models) };
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
        const saved = readSessionSettings(found) ?? {};
        const env = environment(cwd);
        const settings: SessionSettings = {
          modelId: opts.forced?.modelId ?? (saved.model as string) ?? env.models[0]?.id,
          reasoningEffort: (saved.reasoningEffort as ReasoningEffort) ?? "high",
          interactionMode: (saved.interactionMode as InteractionMode) ?? "auto",
          autonomyLevel: opts.forced?.autonomyLevel ?? (saved.autonomyLevel as AutonomyLevel) ?? "off",
        };
        session = build(id, cwd, settings, p, env, { messages: loaded.messages, tokenUsage: saved.tokenUsage });
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
          notify({ type: "agent_working_state_changed", newState: "idle" });
        }
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
        if (patch.modelId !== undefined && !environment(s.cwd).models.some((m) => m.id === patch.modelId)) {
          throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown model: ${patch.modelId}`);
        }
        s.updateSettings(patch);
        return {};
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
        const limit = model?.maxContextLimit ?? 200_000;
        const used = s.lastCallTokenUsage.inputTokens + s.lastCallTokenUsage.cacheReadTokens + s.lastCallTokenUsage.outputTokens;
        return { used, remaining: Math.max(0, limit - used), limit, accuracy: used ? "exact" : "estimated", updatedAt: new Date().toISOString() };
      }
      default:
        if (opts.extraMethods?.[method]) return opts.extraMethods[method](p);
        throw new RpcError(ErrorCodes.METHOD_NOT_FOUND, `Method not found or not in this build: ${METHOD_PREFIX}${method}`);
    }
  }

  return {
    peer,
    get session() { return session; },
    get closed() { return closed; },
    async shutdown() { session?.interrupt(); await session?.idle(); peer.end(); },
  };
}

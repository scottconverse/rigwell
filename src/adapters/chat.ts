// OpenAI-compatible Chat Completions adapter, provider "generic-chat-completion-api" (spec 4.6.1, 4.6.6).
import {
  ModelError,
  type ContentBlock, type Message, type ModelAdapter, type ModelConfig, type ModelRequest, type StreamEvent, type TokenUsage,
} from "../core/types.ts";
import { midStreamBreak } from "./errors.ts";
import { DEFAULT_TIMEOUT_MS, apiUrl, safeJson, sseRequest } from "./sse.ts";

type ReasoningField = "reasoning" | "reasoning_content";
type Obj = Record<string, unknown>;

/** Marker stored in ThinkingBlock.signatureProvider for blocks this adapter produced. */
export const CHAT_SIGNATURE_PROVIDER = "chat";

/** How the profile sends earlier reasoning back: under a field, as `thinking` content parts, or not at all. */
type Replay = "field" | "thinking_parts" | "none";

export interface ChatProfile {
  replay: Replay;
  /** Forced reasoning field name (otherwise the one seen in the stream, else reasoning_content). */
  reasoningField?: ReasoningField;
  /** Gemini thought_signature is read from delta.extra_content.google and replayed the same way. */
  thoughtSignature?: boolean;
  /** Body fields this provider does not accept. */
  unsupported?: string[];
  /** Extra body fields derived from the reasoning effort (lowest precedence). */
  reasoningParams?: (effort: string | undefined) => Obj;
}

const isOff = (e: string | undefined) => !e || e === "off" || e === "none";

/** Per api-provider quirk profiles (spec 4.6.6). */
export const CHAT_PROFILES: Record<string, ChatProfile> = {
  default: { replay: "field" },
  mistral: { replay: "thinking_parts", reasoningField: "reasoning_content" },
  together: {
    replay: "none", reasoningField: "reasoning_content",
    reasoningParams: (e) => (e === undefined ? {} : { reasoning: { enabled: !isOff(e) } }),
  },
  baseten: {
    replay: "none",
    reasoningParams: (e) => (e === undefined ? {} : {
      chat_template_args: { enable_thinking: !isOff(e) },
      ...(isOff(e) ? { reasoning_effort: "low" } : {}),
    }),
  },
  databricks: { replay: "field", unsupported: ["background", "previous_response_id", "store"] },
  google: { replay: "field", thoughtSignature: true },
};

export function profileFor(apiProvider: string | undefined): ChatProfile {
  return (apiProvider && CHAT_PROFILES[apiProvider]) || CHAT_PROFILES.default!;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Replay metadata kept on a thinking block: the reasoning field name and Gemini signatures by call id. */
interface Meta { f?: ReasoningField; g?: Record<string, string> }
function readMeta(b: ContentBlock): Meta | undefined {
  if (b.type !== "thinking" || b.signatureProvider !== CHAT_SIGNATURE_PROVIDER || !b.signature) return undefined;
  const m = safeJson(b.signature);
  return isObj(m) ? (m as Meta) : undefined;
}

/** Reasoning field name seen anywhere in the history, if any. */
function seenField(messages: Message[]): ReasoningField | undefined {
  for (const m of messages) for (const b of m.content) { const f = readMeta(b)?.f; if (f) return f; }
  return undefined;
}

export function mapMessages(req: ModelRequest, profile: ChatProfile): Obj[] {
  const out: Obj[] = [{ role: "system", content: req.system.join("\n\n") }];
  const seen = seenField(req.messages);
  const reasoningOn = !isOff(req.reasoningEffort) || seen !== undefined;
  for (const m of req.messages) {
    if (m.role === "user") {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
      continue;
    }
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const calls = m.content.filter((b) => b.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }>[];
    const thinking = m.content.find((b) => b.type === "thinking" && b.signatureProvider === CHAT_SIGNATURE_PROVIDER) as
      Extract<ContentBlock, { type: "thinking" }> | undefined;
    const meta = thinking ? readMeta(thinking) : undefined;
    const msg: Obj = { role: "assistant", content: text === "" ? null : text };
    if (calls.length) {
      msg.tool_calls = calls.map((c) => {
        const sig = profile.thoughtSignature ? meta?.g?.[c.id] : undefined;
        return {
          id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) },
          ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
        };
      });
    }
    const reasoning = thinking?.thinking ?? "";
    if (profile.replay === "field" && calls.length && (reasoningOn || reasoning !== "")) {
      const field = meta?.f ?? profile.reasoningField ?? seen ?? "reasoning_content";
      msg[field] = reasoning === "" ? " " : reasoning;
    } else if (profile.replay === "thinking_parts" && reasoning !== "") {
      const parts: Obj[] = [{ type: "thinking", thinking: [{ type: "text", text: reasoning }] }];
      if (text !== "") parts.push({ type: "text", text });
      msg.content = parts;
    }
    out.push(msg);
  }
  return out;
}

/** Merge order: profile < model < api-provider-specific (spec 4.6.6). */
function overrides(m: ModelConfig, profile: ChatProfile, effort: string | undefined): Obj {
  const byProvider = m.apiProvider ? m.chatCompletionRequestByProvider?.[m.apiProvider] : undefined;
  return { ...(profile.reasoningParams?.(effort) ?? {}), ...(m.chatCompletionRequest ?? {}), ...(byProvider ?? {}) };
}

export function buildChatBody(req: ModelRequest): Obj {
  const m = req.model;
  const profile = profileFor(m.apiProvider);
  const body: Obj = {
    model: m.model,
    messages: mapMessages(req, profile),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxOutputTokens,
    prompt_cache_key: req.sessionId,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    body.tool_choice = "auto";
  }
  const eff = req.reasoningEffort;
  if (eff && !isOff(eff) && eff !== "dynamic") body.reasoning_effort = eff === "max" ? "high" : eff;
  const merged: Obj = { ...body, ...overrides(m, profile, eff), ...(m.extraArgs ?? {}) };
  for (const k of profile.unsupported ?? []) delete merged[k];
  return merged;
}

function stopReasonOf(finish: string | undefined, hasToolCall: boolean): "end_turn" | "tool_use" | "max_tokens" | "other" {
  if (hasToolCall) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "stop" || finish === undefined || finish === null) return "end_turn";
  return "other";
}

interface CallState { index: number; id: string; name: string; args: string; sig?: string }

export class ChatCompletionsAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const profile = profileFor(m.apiProvider);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : {}),
      ...(m.extraHeaders ?? {}),
    };
    const url = apiUrl(m.baseUrl, "chat/completions");

    let next = 0;
    let reasoningIdx = -1, textIdx = -1;
    let reasoningText = "", text = "";
    let field: ReasoningField | undefined;
    const calls = new Map<number, CallState>();
    const callOrder: CallState[] = [];
    const open = new Set<number>();
    let finish: string | undefined, sawFinish = false;
    let usageRaw: any;
    const close = function* (i: number): Generator<StreamEvent> { if (open.delete(i)) yield { type: "block_stop", index: i }; };

    const events = sseRequest(
      url, { headers, body: JSON.stringify(buildChatBody(req)) }, req.signal,
      req.limits?.hardLimitMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.limits?.idleTimeoutMs,
    );
    for await (const sse of events) {
      if (sse.data.trim() === "[DONE]") break;
      const data = safeJson(sse.data);
      if (!data) continue;
      if (data.error) {
        const msg = `Chat stream error: ${data.error.message ?? JSON.stringify(data.error)}`;
        const code = String(data.error.code ?? data.error.type ?? "");
        if (/rate_limit/i.test(code)) throw new ModelError("rate_limited", msg, { retryable: true });
        if (/overloaded|unavailable|server_error/i.test(code)) throw new ModelError("overloaded", msg, { retryable: true });
        throw new ModelError("unknown", msg);
      }
      if (data.usage) usageRaw = data.usage;
      const choice = data.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // Reasoning: `reasoning` is checked first, then `reasoning_content`; the field found is recorded.
      const viaReasoning = typeof delta.reasoning === "string" && delta.reasoning !== "";
      const rText: string | undefined = viaReasoning ? delta.reasoning
        : typeof delta.reasoning_content === "string" && delta.reasoning_content !== "" ? delta.reasoning_content : undefined;
      if (rText !== undefined) {
        field ??= viaReasoning ? "reasoning" : "reasoning_content";
        if (reasoningIdx < 0) { reasoningIdx = next++; open.add(reasoningIdx); }
        reasoningText += rText;
        yield { type: "thinking_delta", index: reasoningIdx, text: rText };
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        if (reasoningIdx >= 0) yield* close(reasoningIdx);
        if (textIdx < 0) { textIdx = next++; open.add(textIdx); }
        text += delta.content;
        yield { type: "text_delta", index: textIdx, text: delta.content };
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        let key: number;
        if (typeof tc.index === "number") key = tc.index;
        else {
          const byId = tc.id ? callOrder.find((c) => c.id === tc.id) : undefined;
          key = byId ? callOrder.indexOf(byId) : tc.id ? callOrder.length : Math.max(0, callOrder.length - 1);
        }
        let st = calls.get(key);
        if (!st) {
          if (textIdx >= 0) yield* close(textIdx);
          if (reasoningIdx >= 0) yield* close(reasoningIdx);
          st = { index: next++, id: tc.id ?? `call_${key}`, name: tc.function?.name ?? "", args: "" };
          calls.set(key, st); callOrder.push(st); open.add(st.index);
          yield { type: "tool_use_start", index: st.index, id: st.id, name: st.name };
        } else if (tc.function?.name && st.name === "") st.name = tc.function.name;
        if (profile.thoughtSignature) {
          const sig = tc.extra_content?.google?.thought_signature ?? tc.thought_signature;
          if (typeof sig === "string" && sig) st.sig = sig;
        }
        const a = tc.function?.arguments;
        if (typeof a === "string" && a !== "") { st.args += a; yield { type: "tool_input_delta", index: st.index, partialJson: a }; }
      }
      // Gemini may carry the signature on the delta itself rather than per call.
      if (profile.thoughtSignature && callOrder.length) {
        const sig = delta.extra_content?.google?.thought_signature;
        if (typeof sig === "string" && sig) callOrder[callOrder.length - 1]!.sig = sig;
      }
      if (choice.finish_reason) { finish = choice.finish_reason; sawFinish = true; }
    }
    if (!sawFinish) throw midStreamBreak();
    for (const i of [...open]) yield* close(i);

    const content: ContentBlock[] = [];
    const sigs: Record<string, string> = {};
    for (const c of callOrder) if (c.sig) sigs[c.id] = c.sig;
    if (reasoningText !== "" || Object.keys(sigs).length) {
      const meta: Meta = { ...(field ? { f: field } : {}), ...(Object.keys(sigs).length ? { g: sigs } : {}) };
      content.push({ type: "thinking", thinking: reasoningText, signature: JSON.stringify(meta), signatureProvider: CHAT_SIGNATURE_PROVIDER });
    }
    if (text !== "") content.push({ type: "text", text });
    for (const c of callOrder) {
      const parsed = c.args.trim() === "" ? {} : safeJson(c.args);
      content.push({ type: "tool_use", id: c.id, name: c.name, input: isObj(parsed) ? parsed : {} });
    }
    const u = usageRaw ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      outputTokens: u.completion_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      thinkingTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    };
    yield { type: "message_done", content, stopReason: stopReasonOf(finish, callOrder.length > 0), usage };
  }
}

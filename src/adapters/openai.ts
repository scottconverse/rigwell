// OpenAI Responses API over HTTP SSE (spec §4.6.2), fetch + manual parsing.
import {
  ModelError,
  type ContentBlock, type Message, type ModelAdapter, type ModelRequest, type OpenAIReasoning,
  type StreamEvent, type TokenUsage,
} from "../core/types.ts";
import { midStreamBreak } from "./errors.ts";
import { DEFAULT_TIMEOUT_MS, apiUrl, safeJson, sseRequest } from "./sse.ts";
import { oauthHeaders } from "../auth/headers.ts";

export function mapInput(messages: Message[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      let parts: Record<string, unknown>[] = [];
      const flush = () => {
        if (parts.length) items.push({ role: "user", content: parts });
        parts = [];
      };
      for (const b of m.content) {
        if (b.type === "text") parts.push({ type: "input_text", text: b.text });
        else if (b.type === "image") parts.push({ type: "input_image", image_url: `data:${b.mediaType};base64,${b.data}` });
        else if (b.type === "document") parts.push({ type: "input_file", filename: b.name ?? "document.pdf", file_data: `data:${b.mediaType};base64,${b.data}` });
        else if (b.type === "tool_result") {
          flush();
          const output = b.images?.length
            ? [...(b.content ? [{ type: "input_text", text: b.content }] : []), ...b.images.map((i) => ({ type: "input_image", image_url: `data:${i.mediaType};base64,${i.data}` }))]
            : b.content;
          items.push({ type: "function_call_output", call_id: b.tool_use_id, output });
        }
      }
      flush();
    } else {
      for (const r of m.openaiReasoning ?? []) {
        if (!r.encryptedContent) continue; // summary-only items cannot be replayed
        items.push({
          type: "reasoning",
          ...(r.id ? { id: r.id } : {}),
          encrypted_content: r.encryptedContent,
          summary: r.summary ? [{ type: "summary_text", text: r.summary }] : [],
        });
      }
      let text: string[] = [];
      const flush = () => {
        if (text.length) {
          items.push({ type: "message", role: "assistant", content: text.map((t) => ({ type: "output_text", text: t })) });
        }
        text = [];
      };
      for (const b of m.content) {
        if (b.type === "text") { if (b.text) text.push(b.text); }
        else if (b.type === "tool_use") {
          flush();
          items.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        }
      }
      flush();
    }
  }
  return items;
}

export function buildOpenAIBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.model,
    input: mapInput(req.messages),
    instructions: req.system.join("\n\n"),
    tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
    stream: true,
    store: false,
    parallel_tool_calls: true,
    tool_choice: "auto",
    prompt_cache_key: req.sessionId,
    max_output_tokens: req.maxOutputTokens,
  };
  const eff = req.reasoningEffort;
  if (eff && eff !== "off" && eff !== "none" && eff !== "dynamic") {
    body.reasoning = { effort: eff.toLowerCase(), summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  const o = req.openai;
  if (o?.textVerbosity) body.text = { verbosity: o.textVerbosity };
  if (o?.serviceTier) body.service_tier = o.serviceTier;
  if (o?.safetyIdentifier) body.safety_identifier = o.safetyIdentifier === true ? req.sessionId : o.safetyIdentifier;
  if (o?.extendedCache && isOpenAIBaseUrl(req.model.baseUrl)) body.prompt_cache_retention = "24h";
  return { ...body, ...(req.model.extraArgs ?? {}) };
}

/** OpenAI's own API only: Azure and custom endpoints never get prompt_cache_retention (spec 4.6.2). */
export function isOpenAIBaseUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === "api.openai.com"; } catch { return false; }
}

interface ItemState {
  kind: "message" | "function_call" | "reasoning" | "ignore";
  index: number;
  text: string;
  callId: string;
  name: string;
  args: string;
  done: boolean;
}

function failure(code: string | undefined, message: string | undefined): ModelError {
  const msg = `OpenAI stream error${code ? ` (${code})` : ""}: ${message ?? "unknown"}`;
  if (code === "rate_limit_exceeded" || code === "rate_limit_error") return new ModelError("rate_limited", msg, { retryable: true });
  if (code === "server_error" || code === "internal_error" || code === "service_unavailable") return new ModelError("unavailable", msg, { retryable: true });
  if (code === "server_is_overloaded" || code === "overloaded") return new ModelError("overloaded", msg, { retryable: true });
  if (code === "invalid_api_key" || code === "authentication_error") return new ModelError("auth", msg);
  if (code && /invalid|context_length|unsupported|not_found/i.test(code)) return new ModelError("rejected", msg);
  return new ModelError("unknown", msg);
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : {}),
      ...(m.oauth ? await oauthHeaders(m) : {}),
      ...(m.extraHeaders ?? {}),
    };
    const url = apiUrl(m.baseUrl, "responses");
    const items = new Map<number, ItemState>(); // keyed by provider output_index
    const order: ItemState[] = [];
    const reasoning: OpenAIReasoning[] = [];
    let next = 0;
    let final: any = null;
    let incompleteReason: string | undefined;

    const ensure = (outIdx: number, item: any): ItemState => {
      let st = items.get(outIdx);
      if (st) return st;
      const t = item?.type;
      st = {
        kind: t === "message" || t === "function_call" || t === "reasoning" ? t : "ignore",
        index: next, text: "", callId: item?.call_id ?? item?.id ?? "", name: item?.name ?? "", args: "", done: false,
      };
      if (st.kind !== "ignore") { next++; order.push(st); }
      items.set(outIdx, st);
      return st;
    };

    const events = sseRequest(
      url, { headers, body: JSON.stringify(buildOpenAIBody(req)) }, req.signal, req.limits?.hardLimitMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.limits?.idleTimeoutMs,
    );
    outer: for await (const sse of events) {
      const data = safeJson(sse.data);
      if (!data) continue;
      const type: string = data.type ?? sse.event;
      switch (type) {
        case "response.output_item.added": {
          const st = ensure(data.output_index, data.item);
          if (st.kind === "function_call") {
            if (data.item?.call_id) st.callId = data.item.call_id;
            yield { type: "tool_use_start", index: st.index, id: st.callId, name: st.name };
            if (data.item?.arguments) {
              st.args += data.item.arguments;
              yield { type: "tool_input_delta", index: st.index, partialJson: data.item.arguments };
            }
          }
          break;
        }
        case "response.output_text.delta": {
          const st = ensure(data.output_index, { type: "message" });
          if (st.kind === "message" && data.delta) { st.text += data.delta; yield { type: "text_delta", index: st.index, text: data.delta }; }
          break;
        }
        case "response.reasoning_summary_text.delta": {
          const st = ensure(data.output_index, { type: "reasoning" });
          if (st.kind === "reasoning" && data.delta) { st.text += data.delta; yield { type: "thinking_delta", index: st.index, text: data.delta }; }
          break;
        }
        case "response.function_call_arguments.delta": {
          const st = ensure(data.output_index, { type: "function_call" });
          if (st.kind === "function_call" && data.delta) { st.args += data.delta; yield { type: "tool_input_delta", index: st.index, partialJson: data.delta }; }
          break;
        }
        case "response.function_call_arguments.done": {
          const st = items.get(data.output_index);
          if (st && st.kind === "function_call" && typeof data.arguments === "string") st.args = data.arguments;
          break;
        }
        case "response.output_item.done": {
          const item = data.item ?? {};
          const st = ensure(data.output_index, item);
          if (st.kind === "ignore" || st.done) break;
          st.done = true;
          if (st.kind === "function_call") {
            if (typeof item.arguments === "string") st.args = item.arguments;
            if (item.call_id) st.callId = item.call_id;
            if (item.name) st.name = item.name;
          } else if (st.kind === "message" && st.text === "") {
            st.text = (item.content ?? []).map((c: any) => c?.text ?? "").join("");
          } else if (st.kind === "reasoning") {
            const summary = (item.summary ?? []).map((s: any) => s?.text ?? "").filter(Boolean).join("\n\n");
            if (st.text === "") st.text = summary;
            if (item.encrypted_content || item.id) {
              reasoning.push({
                id: item.id ?? "",
                ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
                ...(st.text ? { summary: st.text } : {}),
              });
            }
          }
          yield { type: "block_stop", index: st.index };
          break;
        }
        case "response.completed":
          final = data.response ?? {};
          break outer;
        case "response.incomplete":
          final = data.response ?? {};
          incompleteReason = final?.incomplete_details?.reason;
          break outer;
        case "response.failed": {
          const e = data.response?.error ?? {};
          throw failure(e.code, e.message);
        }
        case "error":
          throw failure(data.code ?? data.error?.code, data.message ?? data.error?.message);
        default:
          break;
      }
    }
    if (!final) throw midStreamBreak();

    const content: ContentBlock[] = [];
    let hasToolCall = false;
    for (const st of order) {
      if (st.kind === "message") { if (st.text !== "") content.push({ type: "text", text: st.text }); }
      else if (st.kind === "reasoning") { if (st.text !== "") content.push({ type: "thinking", thinking: st.text }); }
      else if (st.kind === "function_call") {
        hasToolCall = true;
        const parsed = st.args.trim() === "" ? {} : safeJson(st.args);
        content.push({ type: "tool_use", id: st.callId, name: st.name, input: parsed && typeof parsed === "object" ? parsed : {} });
      }
    }
    const u = final.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached), // uncached, consistent with Anthropic
      outputTokens: u.output_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      thinkingTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    };
    const stopReason = hasToolCall ? "tool_use" : incompleteReason === "max_output_tokens" ? "max_tokens" : incompleteReason ? "other" : "end_turn";
    yield { type: "message_done", content, stopReason, usage, ...(reasoning.length ? { openaiReasoning: reasoning } : {}) };
  }
}

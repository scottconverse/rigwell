// Anthropic Messages API over fetch + manual SSE (spec §6.4).
import {
  ModelError,
  type ContentBlock, type Message, type ModelAdapter, type ModelRequest, type StreamEvent, type TokenUsage,
} from "../core/types.ts";
import { midStreamBreak } from "./errors.ts";
import { DEFAULT_TIMEOUT_MS, apiUrl, safeJson, sseRequest } from "./sse.ts";

const CACHE = { type: "ephemeral", ttl: "1h" } as const;

function mapStop(r: string | null | undefined): "end_turn" | "tool_use" | "max_tokens" | "other" {
  if (r === "end_turn" || r === "stop_sequence") return "end_turn";
  if (r === "tool_use") return "tool_use";
  if (r === "max_tokens") return "max_tokens";
  return "other";
}

function mapBlock(b: ContentBlock): Record<string, unknown> | null {
  switch (b.type) {
    case "text": return b.text === "" ? null : { type: "text", text: b.text };
    case "thinking":
      // Signatures are only valid on the provider that made them.
      if (!b.signature || (b.signatureProvider && b.signatureProvider !== "anthropic")) return null;
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    case "tool_use": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result": {
      const o: Record<string, unknown> = { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content };
      if (b.is_error !== undefined) o.is_error = b.is_error;
      return o;
    }
  }
}

export function mapMessages(messages: Message[]): { role: string; content: Record<string, unknown>[] }[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    const content = m.content.map(mapBlock).filter((x): x is Record<string, unknown> => x !== null);
    if (content.length === 0) continue;
    if (m.role === "user") content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
    out.push({ role: m.role, content });
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === "user") {
      const last = out[i]!.content;
      last[last.length - 1] = { ...last[last.length - 1]!, cache_control: CACHE };
      break;
    }
  }
  return out;
}

export function buildAnthropicBody(req: ModelRequest): Record<string, unknown> {
  const system = req.system.map((text, i) =>
    i === req.system.length - 1 ? { type: "text", text, cache_control: CACHE } : { type: "text", text });
  const body: Record<string, unknown> = {
    model: req.model.model,
    max_tokens: req.maxOutputTokens,
    stream: true,
    messages: mapMessages(req.messages),
  };
  if (system.length) body.system = system;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  return { ...body, ...(req.model.extraArgs ?? {}) };
}

interface BlockState {
  kind: "text" | "thinking" | "tool_use" | "ignore";
  text: string;
  signature: string;
  id: string;
  name: string;
  json: string;
}

function streamError(data: any): ModelError {
  const type = data?.error?.type as string | undefined;
  const msg = `Anthropic stream error${type ? ` (${type})` : ""}: ${data?.error?.message ?? "unknown"}`;
  switch (type) {
    case "overloaded_error": return new ModelError("overloaded", msg, { retryable: true });
    case "rate_limit_error": return new ModelError("rate_limited", msg, { retryable: true });
    case "api_error": return new ModelError("unavailable", msg, { retryable: true });
    case "authentication_error": case "permission_error": return new ModelError("auth", msg);
    case "invalid_request_error": case "not_found_error": case "request_too_large": return new ModelError("rejected", msg);
    default: return new ModelError("unknown", msg);
  }
}

export class AnthropicAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(m.apiKey ? { "x-api-key": m.apiKey } : {}),
      ...(m.extraHeaders ?? {}),
    };
    const url = apiUrl(m.baseUrl, "messages");
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 };
    const blocks = new Map<number, BlockState>();
    let stopReason: string | null = null;
    let finished = false;

    const events = sseRequest(
      url, { headers, body: JSON.stringify(buildAnthropicBody(req)) }, req.signal, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    for await (const sse of events) {
      const data = safeJson(sse.data);
      if (!data) continue;
      const type: string = data.type ?? sse.event;
      if (type === "error") throw streamError(data);
      if (type === "message_start") {
        const u = data.message?.usage ?? {};
        usage.inputTokens = u.input_tokens ?? 0;
        usage.outputTokens = u.output_tokens ?? 0;
        usage.cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
        usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
      } else if (type === "content_block_start") {
        const idx: number = data.index;
        const cb = data.content_block ?? {};
        const st: BlockState = { kind: "ignore", text: "", signature: "", id: "", name: "", json: "" };
        if (cb.type === "text") {
          st.kind = "text";
          if (cb.text) { st.text = cb.text; yield { type: "text_delta", index: idx, text: cb.text }; }
        } else if (cb.type === "thinking") {
          st.kind = "thinking";
          if (cb.thinking) { st.text = cb.thinking; yield { type: "thinking_delta", index: idx, text: cb.thinking }; }
          if (cb.signature) st.signature = cb.signature;
        } else if (cb.type === "tool_use") {
          st.kind = "tool_use"; st.id = cb.id; st.name = cb.name;
          yield { type: "tool_use_start", index: idx, id: cb.id, name: cb.name };
        }
        blocks.set(idx, st);
      } else if (type === "content_block_delta") {
        const idx: number = data.index;
        const st = blocks.get(idx);
        const d = data.delta ?? {};
        if (!st) continue;
        if (d.type === "text_delta" && st.kind === "text") {
          st.text += d.text; yield { type: "text_delta", index: idx, text: d.text };
        } else if (d.type === "thinking_delta" && st.kind === "thinking") {
          st.text += d.thinking; yield { type: "thinking_delta", index: idx, text: d.thinking };
        } else if (d.type === "signature_delta" && st.kind === "thinking") {
          st.signature += d.signature;
        } else if (d.type === "input_json_delta" && st.kind === "tool_use") {
          st.json += d.partial_json; yield { type: "tool_input_delta", index: idx, partialJson: d.partial_json };
        }
      } else if (type === "content_block_stop") {
        const st = blocks.get(data.index);
        if (st && st.kind !== "ignore") yield { type: "block_stop", index: data.index };
      } else if (type === "message_delta") {
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        const u = data.usage ?? {};
        if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
        if (u.input_tokens !== undefined) usage.inputTokens = u.input_tokens;
        if (u.cache_creation_input_tokens !== undefined) usage.cacheCreationTokens = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
      } else if (type === "message_stop") {
        finished = true;
        break;
      }
    }
    if (!finished) throw midStreamBreak();

    const content: ContentBlock[] = [];
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const st = blocks.get(idx)!;
      if (st.kind === "text") {
        if (st.text !== "") content.push({ type: "text", text: st.text });
      } else if (st.kind === "thinking") {
        content.push({ type: "thinking", thinking: st.text, ...(st.signature ? { signature: st.signature, signatureProvider: "anthropic" } : {}) });
      } else if (st.kind === "tool_use") {
        const parsed = st.json.trim() === "" ? {} : safeJson(st.json);
        content.push({ type: "tool_use", id: st.id, name: st.name, input: parsed && typeof parsed === "object" ? parsed : {} });
      }
    }
    yield { type: "message_done", content, stopReason: mapStop(stopReason), usage };
  }
}

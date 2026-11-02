// AWS Bedrock adapters (spec 4.6.10): ConverseStream (provider bedrock-converse) and Anthropic Messages through
// InvokeModelWithResponseStream (provider anthropic with a `bedrock` block). Bedrock OpenAI is the Responses adapter
// with Bedrock auth (src/adapters/openai.ts). Nothing here retries: the harness does (spec 4.6.9).
import {
  ModelError,
  type ContentBlock, type Message, type ModelAdapter, type ModelRequest, type StreamEvent, type TokenUsage,
} from "../core/types.ts";
import { buildAnthropicBody, anthropicEvents } from "./anthropic.ts";
import { bedrockHeaders, parseEventStream, type EventStreamMessage } from "./bedrock-auth.ts";
import { midStreamBreak } from "./errors.ts";
import { DEFAULT_TIMEOUT_MS, guardedRequest, safeJson } from "./sse.ts";

/** Marker stored in ThinkingBlock.signatureProvider for reasoning this adapter produced. */
export const BEDROCK_SIGNATURE_PROVIDER = "bedrock";

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

/** Converse stop reasons: end_turn/stop_sequence -> stop, tool_use -> tool calls, max_tokens -> length, guardrail/content filter -> other (content-filter). */
export function mapConverseStop(r: string | undefined): StopReason {
  if (r === "end_turn" || r === "stop_sequence") return "end_turn";
  if (r === "tool_use") return "tool_use";
  if (r === "max_tokens" || r === "model_context_window_exceeded") return "max_tokens";
  return "other";
}

const FORMATS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif", "image/webp": "webp" };
const imageFormat = (mt: string) => FORMATS[mt] ?? "png";
const imageBlock = (b: { mediaType: string; data: string }) => ({ image: { format: imageFormat(b.mediaType), source: { bytes: b.data } } });
const docName = (n: string | undefined) => (n ?? "document").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9 \-()[\]]/g, " ").replace(/\s+/g, " ").trim() || "document";

export function mapConverseMessages(messages: Message[]): { role: string; content: Record<string, unknown>[] }[] {
  const out: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    const content: Record<string, unknown>[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text": if (b.text.trim() !== "") content.push({ text: b.text }); break;
        case "thinking":
          if (b.signature && b.signatureProvider === BEDROCK_SIGNATURE_PROVIDER) {
            content.push({ reasoningContent: { reasoningText: { text: b.thinking, signature: b.signature } } });
          }
          break;
        case "tool_use": content.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input } }); break;
        case "image": content.push(imageBlock(b)); break;
        case "document": content.push({ document: { format: "pdf", name: docName(b.name), source: { bytes: b.data } } }); break;
        case "tool_result": {
          const inner: Record<string, unknown>[] = [];
          if (b.content !== "") inner.push({ text: b.content });
          for (const i of b.images ?? []) inner.push(imageBlock(i));
          if (inner.length === 0) inner.push({ text: "(no output)" });
          content.push({ toolResult: { toolUseId: b.tool_use_id, content: inner, status: b.is_error ? "error" : "success" } });
          break;
        }
      }
    }
    if (content.length === 0) continue;
    if (m.role === "user") content.sort((a, b) => Number("toolResult" in b) - Number("toolResult" in a));
    out.push({ role: m.role, content });
  }
  return out;
}

const THINKING_BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };

export function buildConverseBody(req: ModelRequest): Record<string, unknown> {
  const m = req.model;
  const body: Record<string, unknown> = {
    messages: mapConverseMessages(req.messages),
    inferenceConfig: { maxTokens: req.maxOutputTokens },
  };
  const system = req.system.filter((t) => t.trim() !== "").map((text) => ({ text }));
  if (system.length) body.system = system;
  if (req.tools.length) {
    body.toolConfig = { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) };
  }
  const eff = req.reasoningEffort;
  if (eff && eff !== "off" && eff !== "none") {
    if (/anthropic\./.test(m.model)) {
      const budget = Math.min(THINKING_BUDGET[eff] ?? 8192, req.maxOutputTokens - 1024);
      if (budget >= 1024) body.additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: budget } };
    } else if (eff !== "dynamic") {
      body.additionalModelRequestFields = { reasoning_effort: eff === "max" || eff === "xhigh" ? "high" : eff };
    }
  }
  return { ...body, ...(m.extraArgs ?? {}) };
}

/** Maps an event-stream exception (or an error JSON body) to a ModelError. */
export function bedrockException(type: string, message: string): ModelError {
  const msg = `Bedrock error (${type}): ${message || "unknown"}`;
  const t = type.replace(/Exception$/, "").toLowerCase();
  if (t === "throttling" || t === "servicequotaexceeded") return new ModelError("rate_limited", msg, { retryable: true });
  if (t === "serviceunavailable" || t === "internalserver" || t === "modelnotready" || t === "modelstreamerror") return new ModelError("unavailable", msg, { retryable: true });
  if (t === "modeltimeout") return new ModelError("timeout", msg, { retryable: true });
  if (t === "accessdenied" || t === "unrecognizedclient" || t === "expiredtoken") return new ModelError("auth", msg);
  if (t === "validation" || t === "resourcenotfound" || t === "modelerror") return new ModelError("rejected", msg);
  return new ModelError("unknown", msg);
}

function failFrame(m: EventStreamMessage): ModelError | undefined {
  const mt = m.headers[":message-type"];
  if (mt === "event") return undefined;
  const type = String(m.headers[":exception-type"] ?? m.headers[":error-code"] ?? "unknown");
  const j = safeJson(new TextDecoder().decode(m.payload));
  return bedrockException(type, String(j?.message ?? j?.Message ?? m.headers[":error-message"] ?? ""));
}

interface Block { kind: "text" | "thinking" | "tool_use"; text: string; sig: string; id: string; name: string; json: string }

export class BedrockConverseAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const url = `${m.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(m.model)}/converse-stream`;
    const bodyText = JSON.stringify(buildConverseBody(req));
    const base = { "content-type": "application/json", accept: "application/vnd.amazon.eventstream", ...(m.extraHeaders ?? {}) };
    const headers = await bedrockHeaders(m, "bedrock", "POST", url, base, bodyText);
    const frames = guardedRequest(url, { headers, body: bodyText }, req.signal,
      req.limits?.hardLimitMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.limits?.idleTimeoutMs, parseEventStream);

    const blocks = new Map<number, Block>();
    const started = new Set<number>();
    let stop: string | undefined;
    let usageRaw: any;
    for await (const frame of frames) {
      const err = failFrame(frame);
      if (err) throw err;
      const type = String(frame.headers[":event-type"] ?? "");
      const data = safeJson(new TextDecoder().decode(frame.payload)) ?? {};
      if (type === "contentBlockStart") {
        const idx: number = data.contentBlockIndex ?? 0;
        const tu = data.start?.toolUse;
        if (tu) {
          blocks.set(idx, { kind: "tool_use", text: "", sig: "", id: tu.toolUseId, name: tu.name, json: "" });
          started.add(idx);
          yield { type: "tool_use_start", index: idx, id: tu.toolUseId, name: tu.name };
        }
      } else if (type === "contentBlockDelta") {
        const idx: number = data.contentBlockIndex ?? 0;
        const d = data.delta ?? {};
        if (typeof d.text === "string") {
          let b = blocks.get(idx);
          if (!b) { b = { kind: "text", text: "", sig: "", id: "", name: "", json: "" }; blocks.set(idx, b); started.add(idx); }
          if (b.kind === "text") { b.text += d.text; yield { type: "text_delta", index: idx, text: d.text }; }
        } else if (d.toolUse && typeof d.toolUse.input === "string") {
          const b = blocks.get(idx);
          if (b?.kind === "tool_use") { b.json += d.toolUse.input; yield { type: "tool_input_delta", index: idx, partialJson: d.toolUse.input }; }
        } else if (d.reasoningContent) {
          let b = blocks.get(idx);
          if (!b) { b = { kind: "thinking", text: "", sig: "", id: "", name: "", json: "" }; blocks.set(idx, b); started.add(idx); }
          if (b.kind === "thinking") {
            if (typeof d.reasoningContent.text === "string") { b.text += d.reasoningContent.text; yield { type: "thinking_delta", index: idx, text: d.reasoningContent.text }; }
            if (typeof d.reasoningContent.signature === "string") b.sig += d.reasoningContent.signature;
          }
        }
      } else if (type === "contentBlockStop") {
        const idx: number = data.contentBlockIndex ?? 0;
        if (started.delete(idx)) yield { type: "block_stop", index: idx };
      } else if (type === "messageStop") {
        stop = data.stopReason ?? "end_turn";
      } else if (type === "metadata") {
        usageRaw = data.usage;
      }
    }
    if (stop === undefined) throw midStreamBreak();

    const content: ContentBlock[] = [];
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const b = blocks.get(idx)!;
      if (b.kind === "text") { if (b.text !== "") content.push({ type: "text", text: b.text }); }
      else if (b.kind === "thinking") {
        content.push({ type: "thinking", thinking: b.text, ...(b.sig ? { signature: b.sig, signatureProvider: BEDROCK_SIGNATURE_PROVIDER } : {}) });
      } else {
        const parsed = b.json.trim() === "" ? {} : safeJson(b.json);
        content.push({ type: "tool_use", id: b.id, name: b.name, input: parsed && typeof parsed === "object" ? parsed : {} });
      }
    }
    const u = usageRaw ?? {};
    const usage: TokenUsage = {
      inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0,
      cacheCreationTokens: u.cacheWriteInputTokens ?? 0, cacheReadTokens: u.cacheReadInputTokens ?? 0, thinkingTokens: 0,
    };
    yield { type: "message_done", content, stopReason: mapConverseStop(stop), usage };
  }
}

/** Body for InvokeModelWithResponseStream of an Anthropic model: the Messages body without model/stream, plus the version marker. */
export function buildBedrockAnthropicBody(req: ModelRequest): Record<string, unknown> {
  const { model: _m, stream: _s, ...rest } = buildAnthropicBody(req);
  // Bedrock takes the plain ephemeral marker; the one-hour ttl is Anthropic API only.
  const text = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...rest }).replace(/,"ttl":"1h"/g, "");
  return JSON.parse(text);
}

export class BedrockAnthropicAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const url = `${m.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(m.model)}/invoke-with-response-stream`;
    const bodyText = JSON.stringify(buildBedrockAnthropicBody(req));
    const base = { "content-type": "application/json", accept: "application/vnd.amazon.eventstream", ...(m.extraHeaders ?? {}) };
    const headers = await bedrockHeaders(m, "bedrock", "POST", url, base, bodyText);
    const frames = guardedRequest(url, { headers, body: bodyText }, req.signal,
      req.limits?.hardLimitMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.limits?.idleTimeoutMs, parseEventStream);
    const events = (async function* () {
      for await (const frame of frames) {
        const err = failFrame(frame);
        if (err) throw err;
        const wrapper = safeJson(new TextDecoder().decode(frame.payload));
        if (typeof wrapper?.bytes !== "string") continue;
        const ev = safeJson(Buffer.from(wrapper.bytes, "base64").toString("utf8"));
        if (ev) yield ev;
      }
    })();
    yield* anthropicEvents(events);
  }
}

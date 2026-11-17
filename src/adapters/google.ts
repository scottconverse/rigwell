// Google Gemini native adapter, provider "google" (spec 4.6.10): streamGenerateContent over SSE.
// Thought signatures are kept on the assistant message and sent back with the tool calls that produced them.
// Custom (freeform) tools are not used: every tool goes out as a function declaration.
import {
  ModelError,
  type ContentBlock, type Message, type ModelAdapter, type ModelRequest, type StreamEvent, type TokenUsage,
} from "../core/types.ts";
import { midStreamBreak } from "./errors.ts";
import { oauthHeaders } from "../auth/headers.ts";
import { DEFAULT_TIMEOUT_MS, safeJson, sseRequest } from "./sse.ts";

export const GOOGLE_SIGNATURE_PROVIDER = "google";
export const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is stored on the thinking block of a Gemini answer: signatures by tool call id, and the one on the text. */
interface Meta { calls?: Record<string, string>; text?: string }
function readMeta(b: ContentBlock): Meta | undefined {
  if (b.type !== "thinking" || b.signatureProvider !== GOOGLE_SIGNATURE_PROVIDER || !b.signature) return undefined;
  const m = safeJson(b.signature);
  return isObj(m) ? (m as Meta) : undefined;
}

export function mapContents(messages: Message[]): Obj[] {
  const names = new Map<string, string>(); // tool call id -> function name, for functionResponse
  for (const m of messages) for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
  const out: Obj[] = [];
  for (const m of messages) {
    const parts: Obj[] = [];
    if (m.role === "user") {
      const results: Obj[] = [];
      for (const b of m.content) {
        if (b.type === "text") { if (b.text !== "") parts.push({ text: b.text }); }
        else if (b.type === "image") parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
        else if (b.type === "document") parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
        else if (b.type === "tool_result") {
          const fr: Obj = {
            name: names.get(b.tool_use_id) ?? "unknown_tool", id: b.tool_use_id,
            response: b.is_error ? { error: b.content } : { output: b.content },
          };
          results.push({ functionResponse: fr });
          for (const i of b.images ?? []) results.push({ inlineData: { mimeType: i.mediaType, data: i.data } });
        }
      }
      parts.unshift(...results); // function responses answer the previous model turn, so they come first
      if (parts.length) out.push({ role: "user", parts });
      continue;
    }
    const meta = m.content.map(readMeta).find((x) => x) ;
    const texts = m.content.filter((b) => b.type === "text") as Extract<ContentBlock, { type: "text" }>[];
    texts.forEach((t, i) => {
      if (t.text === "") return;
      parts.push({ text: t.text, ...(meta?.text && i === texts.length - 1 ? { thoughtSignature: meta.text } : {}) });
    });
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const sig = meta?.calls?.[b.id];
      parts.push({ functionCall: { name: b.name, args: b.input, id: b.id }, ...(sig ? { thoughtSignature: sig } : {}) });
    }
    if (parts.length) out.push({ role: "model", parts });
  }
  return out;
}

const LEVEL: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function buildGoogleBody(req: ModelRequest): Obj {
  const body: Obj = { contents: mapContents(req.messages), generationConfig: { maxOutputTokens: req.maxOutputTokens } };
  const sys = req.system.filter((t) => t.trim() !== "");
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join("\n\n") }] };
  if (req.tools.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  const eff = req.reasoningEffort;
  const gc = body.generationConfig as Obj;
  if (eff === "off" || eff === "none") gc.thinkingConfig = { thinkingBudget: 0 };
  else if (eff === "dynamic") gc.thinkingConfig = { includeThoughts: true, thinkingBudget: -1 };
  else if (eff) gc.thinkingConfig = { includeThoughts: true, thinkingLevel: LEVEL[eff] ?? "high" };
  return { ...body, ...(req.model.extraArgs ?? {}) };
}

function stopOf(finish: string | undefined, hasCall: boolean): "end_turn" | "tool_use" | "max_tokens" | "other" {
  if (hasCall) return "tool_use";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish === "STOP" || finish === undefined) return "end_turn";
  return "other"; // SAFETY, RECITATION, PROHIBITED_CONTENT, ...: content filtered
}

interface Call { index: number; id: string; name: string; args: unknown; sig?: string }

export class GoogleAdapter implements ModelAdapter {
  constructor(private opts: { timeoutMs?: number } = {}) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const m = req.model;
    const base = (m.baseUrl || GOOGLE_DEFAULT_BASE).replace(/\/+$/, "");
    const root = /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
    const url = `${root}/models/${encodeURIComponent(m.model)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(m.apiKey ? { "x-goog-api-key": m.apiKey } : {}),
      ...(m.oauth ? await oauthHeaders(m) : {}),
      ...(m.extraHeaders ?? {}),
    };
    let next = 0;
    let thinkIdx = -1, textIdx = -1;
    let thinking = "", text = "", textSig = "";
    const calls: Call[] = [];
    const open = new Set<number>();
    let finish: string | undefined, sawFinish = false;
    let usageRaw: any;
    const close = function* (i: number): Generator<StreamEvent> { if (open.delete(i)) yield { type: "block_stop", index: i }; };

    const events = sseRequest(url, { headers, body: JSON.stringify(buildGoogleBody(req)) }, req.signal,
      req.limits?.hardLimitMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.limits?.idleTimeoutMs);
    for await (const sse of events) {
      const data = safeJson(sse.data);
      if (!data) continue;
      if (data.error) {
        const msg = `Gemini stream error${data.error.status ? ` (${data.error.status})` : ""}: ${data.error.message ?? "unknown"}`;
        const st = String(data.error.status ?? "");
        if (st === "RESOURCE_EXHAUSTED") throw new ModelError("rate_limited", msg, { retryable: true });
        if (st === "UNAVAILABLE" || st === "INTERNAL" || st === "DEADLINE_EXCEEDED") throw new ModelError("unavailable", msg, { retryable: true });
        throw new ModelError("unknown", msg);
      }
      if (data.usageMetadata) usageRaw = data.usageMetadata;
      if (data.promptFeedback?.blockReason && !data.candidates?.length) {
        throw new ModelError("rejected", `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
      }
      const cand = data.candidates?.[0];
      if (!cand) continue;
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall) {
          if (textIdx >= 0) yield* close(textIdx);
          if (thinkIdx >= 0) yield* close(thinkIdx);
          const fc = part.functionCall;
          const call: Call = { index: next++, id: fc.id || `call_${calls.length}`, name: fc.name ?? "", args: fc.args ?? {}, ...(part.thoughtSignature ? { sig: part.thoughtSignature } : {}) };
          calls.push(call);
          open.add(call.index);
          const json = JSON.stringify(call.args);
          yield { type: "tool_use_start", index: call.index, id: call.id, name: call.name };
          yield { type: "tool_input_delta", index: call.index, partialJson: json };
          yield* close(call.index);
        } else if (typeof part.text === "string") {
          if (part.thought) {
            if (part.text === "") continue;
            if (thinkIdx < 0) { thinkIdx = next++; open.add(thinkIdx); }
            thinking += part.text;
            yield { type: "thinking_delta", index: thinkIdx, text: part.text };
          } else {
            if (part.thoughtSignature) textSig = part.thoughtSignature;
            if (part.text === "") continue;
            if (thinkIdx >= 0) yield* close(thinkIdx);
            if (textIdx < 0) { textIdx = next++; open.add(textIdx); }
            text += part.text;
            yield { type: "text_delta", index: textIdx, text: part.text };
          }
        }
      }
      if (cand.finishReason) { finish = cand.finishReason; sawFinish = true; }
    }
    if (!sawFinish) throw midStreamBreak();
    for (const i of [...open]) yield* close(i);

    const content: ContentBlock[] = [];
    const sigs: Record<string, string> = {};
    for (const c of calls) if (c.sig) sigs[c.id] = c.sig;
    if (thinking !== "" || textSig || Object.keys(sigs).length) {
      const meta: Meta = { ...(Object.keys(sigs).length ? { calls: sigs } : {}), ...(textSig ? { text: textSig } : {}) };
      content.push({ type: "thinking", thinking, signature: JSON.stringify(meta), signatureProvider: GOOGLE_SIGNATURE_PROVIDER });
    }
    if (text !== "") content.push({ type: "text", text });
    for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: isObj(c.args) ? c.args : {} });
    const u = usageRaw ?? {};
    const cached = u.cachedContentTokenCount ?? 0;
    const thoughts = u.thoughtsTokenCount ?? 0;
    const usage: TokenUsage = {
      inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
      outputTokens: (u.candidatesTokenCount ?? 0) + thoughts,
      cacheCreationTokens: 0, cacheReadTokens: cached, thinkingTokens: thoughts,
    };
    yield { type: "message_done", content, stopReason: stopOf(finish, calls.length > 0), usage };
  }
}

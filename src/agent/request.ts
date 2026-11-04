// Request assembly (spec §6.1): [system][tools][history]. A request strictly extends the previous one
// for the session: volatile facts arrive as new messages at the end, the tools array does not change
// when deferred tools load, and cache breakpoints are request-time markers that never alter content.
import type {
  ContentBlock, Message, ModelConfig, ModelRequest, ReasoningEffort, Tool, ToolExecutionMode,
} from "../core/types.ts";
import { CacheMonitor } from "./cache-monitor.ts";
import { systemBlocks, systemChoice } from "./prompts.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export interface BuildInput {
  model: ModelConfig;
  sessionId: string;
  mode: ToolExecutionMode;
  /** What is sent in the tools array (and callable directly). */
  tools: Tool[];
  /** The whole stored history; user_only messages are dropped here. */
  messages: Message[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Extra system blocks after the base ones (a custom subagent's own prompt). */
  extraSystem?: string[];
  /** initialize_session systemPrompt: a string replaces the base prompt; a preset keeps it and appends text. */
  systemPrompt?: string | { type: "preset"; preset?: string; append?: string };
  /** Model profile: replacement tool descriptions by tool name (spec 4.1). */
  toolDescriptions?: Record<string, string>;
  /** Model profile: "none" sends no cache markers. */
  cacheStrategy?: ModelRequest["cacheStrategy"];
  openai?: ModelRequest["openai"];
  /** Prompt-cache key override (side-chat forks use the parent session id). */
  cacheKey?: string;
}

/** Messages the model sees, in order. Encrypted reasoning is dropped when the provider changed. */
export function modelMessages(messages: Message[], provider: string, noImages = false): Message[] {
  return messages
    .filter((m) => m.visibility !== "user_only")
    .map((m) => {
      if (noImages) m = withoutImages(m);
      let out = m.openaiReasoning && m.apiProvider !== provider ? { ...m, openaiReasoning: undefined } : m;
      // A stored `is_error: false` (the transcript writes it) must serialize like the in-memory form that has no field,
      // or a resumed session would not extend the request it sent before it was saved.
      if (out.content.some((b) => b.type === "tool_result" && b.is_error === false)) {
        out = { ...out, content: out.content.map((b) => (b.type === "tool_result" && b.is_error === false ? { type: "tool_result" as const, tool_use_id: b.tool_use_id, content: b.content } : b)) };
      }
      // A result cut for the model: the model sees the short version, the user and the transcript keep the full one.
      if (out.content.some((b) => b.type === "tool_result" && b.modelContent !== undefined)) {
        out = { ...out, content: out.content.map((b) => {
          if (b.type !== "tool_result" || b.modelContent === undefined) return b;
          const { modelContent, ...rest } = b;
          return { ...rest, content: modelContent };
        }) };
      }
      return out;
    });
}

const NO_IMAGE_NOTE = "[An image was attached here, but the current model cannot look at images.]";

/** Replaces image blocks (user attachments and tool result images) with a short text note. */
function withoutImages(m: Message): Message {
  const has = m.content.some((b) => b.type === "image" || (b.type === "tool_result" && b.images?.length));
  if (!has) return m;
  return {
    ...m,
    content: m.content.map((b): ContentBlock => {
      if (b.type === "image") return { type: "text", text: NO_IMAGE_NOTE };
      if (b.type === "tool_result" && b.images?.length) {
        const { images: _i, ...rest } = b;
        return { ...rest, content: `${b.content}\n${NO_IMAGE_NOTE}` };
      }
      return b;
    }),
  };
}

const isText = (b: ContentBlock): b is Extract<ContentBlock, { type: "text" }> => b.type === "text";

/**
 * 1-hour breakpoints on the skills block and the todos block of the context message (prompts.md section 4).
 * Without a skills block the breakpoint moves to the last block before the session block.
 * The system block and the newest user message get theirs in the adapter; four in all.
 */
export function markContextBreakpoints(messages: Message[]): Message[] {
  const i = messages.findIndex((m) => m.id.startsWith("context-") && m.role === "user");
  if (i < 0) return messages;
  const blocks = messages[i]!.content;
  const starts = (b: ContentBlock, tag: string) => isText(b) && b.text.startsWith(tag);
  const todos = blocks.findIndex((b) => starts(b, "<todos>"));
  let skills = blocks.findIndex((b) => starts(b, "<skills>"));
  if (skills < 0) {
    const session = blocks.findIndex((b) => starts(b, "<session>"));
    skills = session > 0 ? session - 1 : -1;
  }
  const marks = new Set([todos, skills].filter((x) => x >= 0));
  if (!marks.size) return messages;
  const out = messages.slice();
  out[i] = { ...messages[i]!, content: blocks.map((b, k) => (marks.has(k) && b.type !== "thinking" ? { ...b, cache: true } : b)) };
  return out;
}

export class RequestBuilder {
  readonly monitor: CacheMonitor;

  constructor(log?: (m: string) => void) {
    this.monitor = new CacheMonitor(log);
  }

  /** The next main-chain request. Registers it with the cache monitor. */
  build(i: BuildInput): ModelRequest {
    const req = this.assemble(i, this.history(i));
    this.monitor.observe(req);
    return req;
  }

  /** The request as it would be built now, without registering it with the monitor (context stats). */
  preview(i: BuildInput): ModelRequest {
    return this.assemble(i, this.history(i));
  }

  private history(i: BuildInput): Message[] {
    const msgs = modelMessages(i.messages, i.model.provider, i.model.noImageSupport === true);
    return i.cacheStrategy === "none" ? msgs : markContextBreakpoints(msgs);
  }

  /**
   * A cache-priming request for the current prefix (warmup_cache). It carries the same system, tools and
   * history; when the history ends with an assistant message a short user message follows it, and the last
   * history block gets the breakpoint so the real next request finds the prefix. Not part of the monitored chain.
   */
  buildWarmup(i: BuildInput): ModelRequest {
    let msgs = this.history(i);
    if (msgs.at(-1)?.role === "assistant") {
      const last = msgs.at(-1)!;
      const k = last.content.map((b) => b.type).lastIndexOf("text");
      const t = k >= 0 ? k : last.content.findIndex((b) => b.type === "tool_use");
      const marked = t >= 0 ? { ...last, content: last.content.map((b, n) => (n === t ? { ...b, cache: true } : b)) } : last;
      msgs = [...msgs.slice(0, -1), marked,
        { id: "warmup", role: "user", content: [{ type: "text", text: "<system-reminder>Cache warm-up. Reply with one word.</system-reminder>" }] }];
    }
    return this.assemble({ ...i, maxOutputTokens: 16 }, msgs);
  }

  private assemble(i: BuildInput, messages: Message[]): ModelRequest {
    return {
      model: i.model, sessionId: i.sessionId, system: [...systemBlocks(i.mode, systemChoice(i.systemPrompt)), ...(i.extraSystem ?? [])],
      tools: i.tools.map((t) => ({ name: t.name, description: i.toolDescriptions?.[t.name] ?? t.description, inputSchema: t.inputSchema })),
      messages, ...(i.cacheStrategy ? { cacheStrategy: i.cacheStrategy } : {}), ...(i.openai ? { openai: i.openai } : {}), ...(i.cacheKey ? { cacheKey: i.cacheKey } : {}),
      maxOutputTokens: i.maxOutputTokens ?? i.model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: i.reasoningEffort, signal: i.signal,
    };
  }
}

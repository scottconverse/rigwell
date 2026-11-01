// Compaction (spec §4.4, prompts.md §6): when the context nears its limit, an LLM writes a handoff summary of the
// old conversation. The system block and tools stay byte-identical; the next request opens with the summary, the
// re-injected context blocks, the recent turns kept verbatim, then the new prompt.
import type { Message, ModelConfig, ModelRequest, StreamEvent, TokenUsage } from "../core/types.ts";
import type { CompactionRecord } from "../storage/transcript.ts";
import { blockChars, estimateTokens, messagesChars } from "./budget.ts";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";
import { render } from "./prompts.ts";

export interface CompactionConfig {
  /** Room kept free for the summary; also the summarizer's output limit before the custom-model cap. */
  reserveTokens: number;
  /** Length asked for in the summarizer's instructions. */
  targetTokens: number;
  /** Added to a requested output limit when the call expects text (always for custom models). */
  textHeadroom: number;
  /** Summarizer output limit for a custom model with no maxOutputTokens. */
  customModelCap: number;
  /** Upper bound for what is kept after a compaction (summary + context + recent turns). */
  postCeilingTokens: number;
  /** At most this many recent turns are kept verbatim (and never every turn: something must be summarized). */
  keepRecentTurns: number;
  /** Per tool result in the transcript sent to the summarizer. */
  toolResultCapChars: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  reserveTokens: 16_000, targetTokens: 4_000, textHeadroom: 8_192, customModelCap: 8_000,
  postCeilingTokens: 40_000, keepRecentTurns: 2, toolResultCapChars: 4_000,
};

export function resolveCompaction(s: Partial<CompactionConfig> | undefined): CompactionConfig {
  const out: CompactionConfig = { ...DEFAULT_COMPACTION };
  for (const k of Object.keys(DEFAULT_COMPACTION) as (keyof CompactionConfig)[]) {
    const v = s?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Summarizer output limit and the `max_tokens` actually requested (spec §4.4 chain). */
export function summarizerTokens(model: ModelConfig, cfg: CompactionConfig): { limit: number; requested: number } {
  const limit = Math.min(cfg.reserveTokens, model.maxOutputTokens ?? cfg.customModelCap);
  const withHeadroom = limit + cfg.textHeadroom;
  return { limit, requested: model.maxOutputTokens ? Math.min(withHeadroom, model.maxOutputTokens) : withHeadroom };
}

// ---------- what to keep ----------

const SYNTHETIC_PREFIX = /^(context-|notice-|deferred-)/;

/** A message that starts a user turn: a user message with no tool results that is not a context or reminder message. */
export function isTurnStart(m: Message): boolean {
  return m.role === "user" && m.visibility !== "user_only" && !SYNTHETIC_PREFIX.test(m.id) && !m.content.some((b) => b.type === "tool_result");
}

/**
 * Index of the first message kept verbatim; everything before it is summarized. The kept part starts at a turn start,
 * holds at most `keepRecentTurns` turns and at most `budgetTokens`, and never covers every turn. `view.length` means
 * nothing is kept. Returns 0 when there is nothing worth summarizing.
 */
export function pickCut(view: Message[], budgetTokens: number, keepRecentTurns: number): number {
  const starts = view.map((m, i) => (isTurnStart(m) ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0) return 0;
  const maxKeep = Math.min(keepRecentTurns, starts.length - 1);
  for (let k = maxKeep; k >= 1; k--) {
    const i = starts[starts.length - k]!;
    if (estimateTokens(messagesChars(view.slice(i))) <= budgetTokens) return i;
  }
  return view.length;
}

// ---------- the summarizer request ----------

function blockKind(text: string): string | null {
  if (text.startsWith("<environment>")) return "environment block";
  if (text.startsWith("<session>")) return "session block";
  if (text.startsWith("<todos>")) return "todos block";
  if (text.startsWith("<project_instructions>")) return "project instructions block";
  if (text.startsWith("<skills>")) return "skills block";
  if (text.startsWith("<system-reminder>") && text.length > 300) return "reminder";
  return null;
}

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n >> 1)}\n[... ${s.length - n} characters cut ...]\n${s.slice(-(n >> 1))}`);

/** Plain-text transcript for the summarizer. Bulky reminder and context blocks become omission markers. */
export function serializeTranscript(messages: Message[], toolResultCap: number): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.visibility === "user_only") continue;
    const parts: string[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text": {
          const kind = blockKind(b.text);
          parts.push(kind ? render(PROMPT_TEXT.compact_omitted_marker, { BLOCK_KIND: kind, CHARS: b.text.length }) : b.text);
          break;
        }
        case "thinking": break; // not shown: private reasoning
        case "tool_use": parts.push(`[tool call ${b.name}] ${cap(JSON.stringify(b.input), toolResultCap)}`); break;
        case "tool_result": parts.push(`[tool result${b.is_error ? " (error)" : ""}] ${cap(b.content, toolResultCap)}`); break;
      }
    }
    if (parts.length) out.push(`[${m.role}]\n${parts.join("\n")}`);
  }
  return out.join("\n\n");
}

/** A code fence longer than any backtick run in the text. */
export function fenceFor(text: string): string {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

export interface SummarizerRequest { req: Omit<ModelRequest, "signal">; transcriptChars: number; limit: number }

/** The compaction request: one system block, no tools, one user message with the transcript in a fence. */
export function buildSummarizerRequest(o: {
  model: ModelConfig; sessionId: string; messages: Message[]; cfg: CompactionConfig; customInstructions?: string;
  limits?: ModelRequest["limits"];
}): SummarizerRequest {
  const { limit, requested } = summarizerTokens(o.model, o.cfg);
  const window = o.model.maxContextLimit ?? 200_000;
  const budgetChars = Math.max(4_000, (window - requested - 3_000) * 4);
  let transcript = "";
  for (const capChars of [o.cfg.toolResultCapChars, 1_500, 400, 100]) {
    transcript = serializeTranscript(o.messages, capChars);
    if (transcript.length <= budgetChars) break;
  }
  if (transcript.length > budgetChars) {
    // Still too big: keep the newest part and say how much was left out.
    const dropped = transcript.length - budgetChars;
    transcript = `[${dropped} characters of the oldest conversation omitted at compaction boundary]\n` + transcript.slice(dropped);
  }
  const fence = fenceFor(transcript);
  let user = render(PROMPT_TEXT.compact_user, { FENCE: fence, TRANSCRIPT: transcript });
  if (o.customInstructions?.trim()) user += `\n\nAdditional instructions from the user for this summary:\n${o.customInstructions.trim()}`;
  return {
    transcriptChars: transcript.length, limit,
    req: {
      model: o.model, sessionId: o.sessionId,
      system: [render(PROMPT_TEXT.compact_system, { SUMMARY_TARGET_TOKENS: o.cfg.targetTokens })],
      tools: [],
      messages: [{ id: "compact-request", role: "user", content: [{ type: "text", text: user }] }],
      maxOutputTokens: requested, reasoningEffort: "off", limits: o.limits,
    },
  };
}

/** Runs the summarizer stream and returns the summary text. */
export async function collectSummary(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ text: string; usage: TokenUsage | undefined; stopReason?: string }> {
  let usage: TokenUsage | undefined;
  let text = "";
  let stopReason: string | undefined;
  for await (const ev of stream) {
    if (ev.type === "message_done") {
      usage = ev.usage;
      stopReason = ev.stopReason;
      text = ev.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    }
  }
  return { text: text.trim(), usage, stopReason };
}

// ---------- the message after compaction ----------

/** Text blocks of the first message after compaction: preamble with the summary, then the re-injected blocks. */
export function preambleBlocks(summary: string, context: string[], extra: string[]): string[] {
  return [render(PROMPT_TEXT.compact_preamble, { SUMMARY: summary }), ...context, ...extra];
}

/** The old context message's text blocks (environment, session, todos, ...) to re-inject. */
export function contextTextBlocks(view: Message[]): string[] {
  const m = view.find((x) => x.role === "user" && x.id.startsWith("context-"));
  if (!m) return [];
  // A second compaction re-injects only the blocks after the earlier preamble block.
  const texts = m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  return texts.filter((t) => !t.startsWith("This session continues from an earlier conversation") && !t.startsWith("<system-reminder>\nDeferred tools") && !t.startsWith("<system-reminder>\nTools loaded"));
}

export function preambleMessage(id: string, blocks: string[]): Message {
  return { id, role: "user", visibility: "llm_only", content: blocks.map((text) => ({ type: "text", text })) };
}

/**
 * Rebuilds the model's history from the full transcript and its latest compaction record (spec §12.1):
 * the preamble message, then only the messages after the anchor. `archived` is everything before, kept for the UI.
 */
export function applyCompaction(all: Message[], rec: CompactionRecord | undefined): { view: Message[]; archived: Message[] } {
  if (!rec) return { view: all, archived: [] };
  let idx = all.findIndex((m) => m.id === rec.anchorMessage.id);
  if (idx < 0) idx = Math.min(all.length - 1, Math.max(-1, rec.anchorMessage.index));
  return {
    view: [preambleMessage(rec.preambleMessageId, rec.preambleBlocks), ...all.slice(idx + 1)],
    archived: all.slice(0, idx + 1),
  };
}

/** Estimated tokens of a message list. */
export const messagesTokens = (ms: Message[]) => estimateTokens(messagesChars(ms));
export { blockChars };

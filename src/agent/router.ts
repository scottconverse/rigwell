// Automatic model routing (spec §4.5). The model id "auto" runs a small classifier model per request over the
// configured candidates, picks the cheapest one that clears the quality bar, and keeps the rest as score-ordered
// fallbacks. The classifier prompt is Rigwell's own (prompts.md has none).
import type { Message, ModelConfig, ModelRequest, StreamEvent } from "../core/types.ts";
import { estimateTokens } from "./budget.ts";

export const AUTO_MODEL_ID = "auto";

export interface RouterCandidate {
  /** Model id from customModels (e.g. "custom:Fast-0"). */
  model: string;
  /** One line the classifier reads. */
  description: string;
  /** Relative input cost; the cheapest qualifying candidate wins. */
  inputCost: number;
}

export interface RouterConfig {
  /** Model id of the classifier (a small cheap model). */
  classifierModel: string;
  candidates: RouterCandidate[];
  /** Fitness bar, default 0.7. */
  threshold?: number;
  /** Classifier timeout, default 10 s. */
  timeoutMs?: number;
}

export type RouteReason = "policy" | "hard" | "routine" | "task_fit" | "fallback";

export interface RouteChoice {
  modelId: string;
  reason: RouteReason;
  scores: Record<string, number>;
  fallbacks: string[];
}

export const ROUTER_INPUT_TOKENS = 16_000;
export const ROUTER_MAX_OUTPUT = 8_192;

const cut = (s: string, n = 2000) => (s.length <= n * 2 ? s : `${s.slice(0, n)}\n[... cut ...]\n${s.slice(-n)}`);

function textOf(m: Message): string {
  return m.content.map((b) => {
    switch (b.type) {
      case "text": return b.text;
      case "tool_use": return `[tool call ${b.name}] ${JSON.stringify(b.input)}`;
      case "tool_result": return `[tool result] ${b.content}`;
      default: return "";
    }
  }).filter(Boolean).join("\n");
}

/**
 * Classifier input in priority order within the token budget: the turn context (the latest user prompt), the last 6
 * messages, the last 8 tool calls. Long text keeps its first and last 2,000 characters.
 */
export function classifierInput(messages: Message[], budgetTokens = ROUTER_INPUT_TOKENS): string {
  const visible = messages.filter((m) => m.visibility !== "user_only");
  const prompt = [...visible].reverse().find((m) => m.role === "user" && !m.content.some((b) => b.type === "tool_result") && !/^(context-|notice-|deferred-)/.test(m.id));
  const parts: string[] = [];
  let used = 0;
  const add = (label: string, body: string): boolean => {
    const text = `## ${label}\n${cut(body)}\n`;
    const t = estimateTokens(text.length);
    if (used + t > budgetTokens) return false;
    used += t;
    parts.push(text);
    return true;
  };
  if (prompt) add("Current request", textOf(prompt));
  const calls = visible.flatMap((m) => m.content.filter((b) => b.type === "tool_use")).slice(-8) as Extract<Message["content"][number], { type: "tool_use" }>[];
  for (const c of calls.reverse()) if (!add("Recent tool call", `${c.name} ${JSON.stringify(c.input)}`)) break;
  for (const m of visible.slice(-6).reverse()) if (!add(`Recent ${m.role} message`, textOf(m))) break;
  return parts.join("\n");
}

export const ROUTER_SYSTEM =
  "You rate how well each candidate model fits the next step of a coding session. For every candidate give a fitness score from 0 to 1 (1 = clearly capable, 0 = cannot do it), a short label, and a one-line reason. Reply with JSON only, in this shape: {\"scores\":{\"<candidate id>\":{\"score\":0.0,\"label\":\"...\",\"reason\":\"...\"}}}";

export function classifierMessages(c: RouterConfig, input: string): Message[] {
  const list = c.candidates.map((x) => `- ${x.model}: ${x.description}`).join("\n");
  return [{ id: "router-request", role: "user", content: [{ type: "text", text: `Candidates:\n${list}\n\nSession so far:\n${input}` }] }];
}

/** Scores from the classifier's reply. Recovers from fences, prose around the JSON, and bare "id": number pairs. */
export function parseScores(reply: string, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const fromObj = (o: any) => {
    const scores = o?.scores ?? o;
    if (!scores || typeof scores !== "object") return;
    for (const id of ids) {
      const v = scores[id];
      const n = typeof v === "number" ? v : typeof v?.score === "number" ? v.score : undefined;
      if (n !== undefined && Number.isFinite(n)) out[id] = Math.max(0, Math.min(1, n));
    }
  };
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  const first = reply.indexOf("{"), last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) fromObj(tryParse(reply.slice(first, last + 1)));
  if (Object.keys(out).length === 0) {
    for (const id of ids) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`"?${esc}"?\\s*[:=]\\s*(?:\\{[^}]*?"?score"?\\s*:\\s*)?([01](?:\\.\\d+)?)`).exec(reply);
      if (m) out[id] = Math.max(0, Math.min(1, Number(m[1])));
    }
  }
  return out;
}

/** The pick rule: cheapest candidate at or above the bar (ties: higher score); else the best; all zero: the first. */
export function pickRoute(c: RouterConfig, scores: Record<string, number>): RouteChoice {
  const bar = c.threshold ?? 0.7;
  const list = c.candidates;
  const s = (id: string) => scores[id] ?? 0;
  const byScore = (a: RouterCandidate, b: RouterCandidate) => s(b.model) - s(a.model);
  let chosen: RouterCandidate;
  let reason: RouteReason;
  const ok = list.filter((x) => s(x.model) >= bar);
  if (list.length === 1) { chosen = list[0]!; reason = "policy"; }
  else if (ok.length) {
    chosen = [...ok].sort((a, b) => a.inputCost - b.inputCost || s(b.model) - s(a.model))[0]!;
    reason = ok.length / list.length >= 0.75 ? "routine" : "task_fit";
  } else if (list.every((x) => s(x.model) === 0)) { chosen = list[0]!; reason = "hard"; }
  else { chosen = [...list].sort(byScore)[0]!; reason = "hard"; }
  return {
    modelId: chosen.model, reason, scores: Object.fromEntries(list.map((x) => [x.model, s(x.model)])),
    fallbacks: list.filter((x) => x !== chosen).sort(byScore).map((x) => x.model),
  };
}

export interface ClassifyDeps {
  resolveModel: (id: string) => ModelConfig | undefined;
  stream: (model: ModelConfig, req: ModelRequest) => AsyncIterable<StreamEvent>;
}

/** Runs the classifier and picks. Any failure falls back to the first candidate (reason "fallback"). */
export async function route(c: RouterConfig, messages: Message[], deps: ClassifyDeps, signal?: AbortSignal): Promise<RouteChoice> {
  const ids = c.candidates.map((x) => x.model);
  const fallback = (): RouteChoice => ({ modelId: ids[0]!, reason: "fallback", scores: {}, fallbacks: ids.slice(1) });
  if (!ids.length) throw new Error("auto routing has no candidates");
  if (ids.length === 1) return pickRoute(c, {});
  const model = deps.resolveModel(c.classifierModel);
  if (!model) return fallback();
  const req: ModelRequest = {
    model, sessionId: "router", system: [ROUTER_SYSTEM], tools: [], messages: classifierMessages(c, classifierInput(messages)),
    maxOutputTokens: ROUTER_MAX_OUTPUT, reasoningEffort: "low", signal,
    limits: { hardLimitMs: c.timeoutMs ?? 10_000, idleTimeoutMs: c.timeoutMs ?? 10_000 },
  };
  try {
    let text = "";
    for await (const ev of deps.stream(model, req)) {
      if (ev.type === "message_done") text = ev.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    }
    const scores = parseScores(text, ids);
    return Object.keys(scores).length ? pickRoute(c, scores) : fallback();
  } catch {
    return fallback();
  }
}

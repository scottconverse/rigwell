import type { TokenUsage } from "../core/types.ts";

export type AnalyticsMetric =
  | { kind: "usage"; model: string; purpose: string; usage: TokenUsage }
  | { kind: "tool"; id: string; name: string; status: "started" | "success" | "failure"; source: "native"; model?: string }
  | { kind: "turn"; id: string; durationMs: number; reason: string };

export const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "thinkingTokens"] as const;
export function cleanUsage(raw: any): TokenUsage {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, typeof raw?.[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : 0])) as unknown as TokenUsage;
}

/** Only accounting fields enter the cache, never prompts, arguments, output or credentials. */
export function metricsOf(record: any): Record<string, any>[] {
  const m = record.metric;
  if (record.type === "analytics_metric" && m && typeof m === "object") {
    if (m.kind === "usage" && typeof m.model === "string" && typeof m.purpose === "string") return [{ kind: "usage", model: m.model, purpose: m.purpose, usage: cleanUsage(m.usage) }];
    if (m.kind === "tool" && typeof m.id === "string" && typeof m.name === "string" && ["started", "success", "failure"].includes(m.status)) return [{ kind: "tool", id: m.id, name: m.name, status: m.status, source: "native", ...(typeof m.model === "string" ? { model: m.model } : {}) }];
    if (m.kind === "turn" && typeof m.id === "string" && typeof m.reason === "string" && Number.isFinite(m.durationMs) && m.durationMs >= 0) return [{ kind: "turn", id: m.id, reason: m.reason, durationMs: m.durationMs }];
  }
  if (record.type !== "message" || !Array.isArray(record.message?.content)) return [];
  return record.message.content.flatMap((b: any) => {
    if (record.message.role === "assistant" && b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") return [{ kind: "tool", id: b.id, name: b.name, status: "started", source: "rigwell", ...(typeof record.message.modelId === "string" ? { model: record.message.modelId } : {}) }];
    if (record.message.role === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") return [{ kind: "result", id: b.tool_use_id, status: b.is_error === true ? "failure" : "success" }];
    return [];
  });
}

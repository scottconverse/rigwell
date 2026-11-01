import type { Message, ModelConfig, ModelRequest, StreamEvent } from "../../src/core/types.ts";

export function model(provider: "anthropic" | "openai", baseUrl: string, extra: Partial<ModelConfig> = {}): ModelConfig {
  return { id: "custom:fake", model: "fake-model", displayName: "Fake", provider, baseUrl, apiKey: "test-key", ...extra };
}

export const userMsg = (text: string, id = "u1"): Message => ({ id, role: "user", content: [{ type: "text", text }] });

export function request(m: ModelConfig, messages: Message[], extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: m, sessionId: "sess-123", system: ["identity line", "base prompt"],
    tools: [{ name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    messages, maxOutputTokens: 4096, ...extra,
  };
}

export async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export function done(events: StreamEvent[]) {
  const d = events.find((e) => e.type === "message_done");
  if (!d || d.type !== "message_done") throw new Error("no message_done");
  return d;
}

// Scripted fake OpenAI-compatible Chat Completions server (streamed /v1/chat/completions).
import { PrefixCache, splitChunks, startFake, type FakeOptions, type FakeServer, type FakeTurn, type FakeTurnSpec, type PrefixModel } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

/** A turn plus chat-only knobs. */
export type FakeChatTurnSpec = FakeTurnSpec & {
  /** Which delta field carries `thinking` (default reasoning_content). */
  reasoningField?: "reasoning" | "reasoning_content";
  /** Gemini-style signature attached to every tool call under extra_content.google.thought_signature. */
  thoughtSignature?: string;
  finishReason?: string;
};

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function render(t: FakeTurnSpec, idx: number): string[] {
  const turn = t as FakeChatTurnSpec;
  const f: string[] = [];
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    f.push(data({ id: `chatcmpl_fake_${idx}`, object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] }));
  chunk({ role: "assistant", content: "" });
  if (turn.thinking !== undefined) {
    const field = turn.reasoningField ?? "reasoning_content";
    for (const c of splitChunks(turn.thinking)) chunk({ [field]: c });
  }
  if (turn.text !== undefined) for (const c of splitChunks(turn.text)) chunk({ content: c });
  (turn.toolCalls ?? []).forEach((tc, n) => {
    const id = tc.id ?? `call_fake_${idx}_${n}`;
    const args = JSON.stringify(tc.input);
    chunk({ tool_calls: [{ index: n, id, type: "function", function: { name: tc.name, arguments: "" },
      ...(turn.thoughtSignature ? { extra_content: { google: { thought_signature: turn.thoughtSignature } } } : {}) }] });
    for (const c of splitChunks(args, 3)) chunk({ tool_calls: [{ index: n, function: { arguments: c } }] });
  });
  chunk({}, turn.finishReason ?? ((turn.toolCalls ?? []).length ? "tool_calls" : "stop"));
  const u = turn.usage ?? {};
  const input = u.input ?? 10;
  f.push(data({
    id: `chatcmpl_fake_${idx}`, object: "chat.completion.chunk", model: "fake", choices: [],
    usage: {
      prompt_tokens: input + (u.cacheRead ?? 0), completion_tokens: u.output ?? 5,
      prompt_tokens_details: { cached_tokens: u.cacheRead ?? 0 },
      completion_tokens_details: { reasoning_tokens: turn.thinking !== undefined ? 2 : 0 },
    },
  }));
  f.push("data: [DONE]\n\n");
  return f;
}

/** Chat order: tools, then messages. Caching is automatic. */
export function chatPrefix(body: any): PrefixModel {
  const blocks: string[] = [];
  for (const t of body.tools ?? []) blocks.push(JSON.stringify(t));
  for (const m of body.messages ?? []) blocks.push(JSON.stringify(m));
  return { blocks, breakpoints: [] };
}

export function startFakeChat(script: (FakeChatTurnSpec | ((body: any, index: number) => FakeChatTurnSpec))[], opts: FakeOptions = {}): Promise<FakeServer> {
  return startFake(script as FakeTurn[], render, (_s, message) => ({ error: { message, type: "server_error", code: null } }),
    opts.simulateCache ? { model: chatPrefix, sim: new PrefixCache("automatic") } : undefined);
}

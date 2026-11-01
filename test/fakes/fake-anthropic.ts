import { sse, splitChunks, startFake, type FakeServer, type FakeTurn, type FakeTurnSpec } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

function render(turn: FakeTurnSpec, idx: number): string[] {
  const f: string[] = [];
  const u = turn.usage ?? {};
  f.push(sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_fake_${idx}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null,
      usage: { input_tokens: u.input ?? 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: u.cacheRead ?? 0 },
    },
  }));
  let i = 0;
  if (turn.thinking !== undefined) {
    f.push(sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }));
    for (const c of splitChunks(turn.thinking)) f.push(sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: c } }));
    f.push(sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig-fake" } }));
    f.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    i++;
  }
  if (turn.text !== undefined) {
    f.push(sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }));
    for (const c of splitChunks(turn.text)) f.push(sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: c } }));
    f.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    i++;
  }
  (turn.toolCalls ?? []).forEach((tc, n) => {
    f.push(sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: tc.id ?? `toolu_fake_${idx}_${n}`, name: tc.name, input: {} } }));
    for (const c of splitChunks(JSON.stringify(tc.input), 3)) f.push(sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: c } }));
    f.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    i++;
  });
  f.push(sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.toolCalls?.length ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: u.output ?? 5 },
  }));
  f.push(sse("message_stop", { type: "message_stop" }));
  return f;
}

export function startFakeAnthropic(script: FakeTurn[]): Promise<FakeServer> {
  return startFake(script, render, (_s, message) => ({ type: "error", error: { type: "api_error", message } }));
}

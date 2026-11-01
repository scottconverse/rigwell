import { PrefixCache, sse, splitChunks, startFake, type FakeOptions, type FakeServer, type FakeTurn, type FakeTurnSpec, type PrefixModel } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

function render(turn: FakeTurnSpec, idx: number): string[] {
  const f: string[] = [];
  const u = turn.usage ?? {};
  f.push(sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_fake_${idx}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null,
      usage: { input_tokens: u.input ?? 10, output_tokens: 1, cache_creation_input_tokens: u.cacheCreation ?? 0, cache_read_input_tokens: u.cacheRead ?? 0 },
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

const stripCache = (b: any) => { const { cache_control: _c, ...rest } = b; return JSON.stringify(rest); };

/** Anthropic order is tools, system, messages; a breakpoint ends at the block that carries cache_control. */
export function anthropicPrefix(body: any): PrefixModel {
  const blocks: string[] = [];
  const breakpoints: number[] = [];
  for (const t of body.tools ?? []) blocks.push(JSON.stringify(t));
  for (const b of body.system ?? []) { blocks.push(stripCache(b)); if (b.cache_control) breakpoints.push(blocks.length); }
  for (const m of body.messages ?? []) {
    for (const b of m.content ?? []) {
      blocks.push(JSON.stringify({ role: m.role, block: JSON.parse(stripCache(b)) }));
      if (b.cache_control) breakpoints.push(blocks.length);
    }
  }
  return { blocks, breakpoints };
}

export function startFakeAnthropic(script: FakeTurn[], opts: FakeOptions = {}): Promise<FakeServer> {
  return startFake(script, render, (_s, message) => ({ type: "error", error: { type: "api_error", message } }),
    opts.simulateCache ? { model: anthropicPrefix, sim: new PrefixCache("explicit") } : undefined);
}

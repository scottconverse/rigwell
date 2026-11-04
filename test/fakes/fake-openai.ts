import { PrefixCache, sse, splitChunks, startFake, type FakeOptions, type FakeServer, type FakeTurn, type FakeTurnSpec, type PrefixModel } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

/** The Responses events of one scripted turn, as objects (the WebSocket fake sends them as frames). */
export function openaiEvents(turn: FakeTurnSpec, idx: number): any[] {
  const f: any[] = [];
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) => f.push({ type, sequence_number: seq++, ...data });
  const u = turn.usage ?? {};
  const resp = (status: string, extra: Record<string, unknown> = {}) => ({ id: `resp_fake_${idx}`, object: "response", status, output: [], ...extra });
  ev("response.created", { response: resp("in_progress") });
  let o = 0;
  if (turn.thinking !== undefined) {
    const id = `rs_fake_${idx}`;
    ev("response.output_item.added", { output_index: o, item: { id, type: "reasoning", summary: [] } });
    ev("response.reasoning_summary_part.added", { output_index: o, item_id: id, summary_index: 0, part: { type: "summary_text", text: "" } });
    for (const c of splitChunks(turn.thinking)) ev("response.reasoning_summary_text.delta", { output_index: o, item_id: id, summary_index: 0, delta: c });
    ev("response.output_item.done", {
      output_index: o,
      item: { id, type: "reasoning", encrypted_content: `enc-fake-${idx}`, summary: [{ type: "summary_text", text: turn.thinking }] },
    });
    o++;
  }
  if (turn.text !== undefined) {
    const id = `msg_fake_${idx}`;
    ev("response.output_item.added", { output_index: o, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } });
    ev("response.content_part.added", { output_index: o, item_id: id, content_index: 0, part: { type: "output_text", text: "" } });
    for (const c of splitChunks(turn.text)) ev("response.output_text.delta", { output_index: o, item_id: id, content_index: 0, delta: c });
    ev("response.output_text.done", { output_index: o, item_id: id, content_index: 0, text: turn.text });
    ev("response.output_item.done", {
      output_index: o,
      item: { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.text }] },
    });
    o++;
  }
  (turn.toolCalls ?? []).forEach((tc, n) => {
    const id = `fc_fake_${idx}_${n}`;
    const callId = tc.id ?? `call_fake_${idx}_${n}`;
    const args = JSON.stringify(tc.input);
    ev("response.output_item.added", { output_index: o, item: { id, type: "function_call", call_id: callId, name: tc.name, arguments: "" } });
    for (const c of splitChunks(args, 3)) ev("response.function_call_arguments.delta", { output_index: o, item_id: id, delta: c });
    ev("response.function_call_arguments.done", { output_index: o, item_id: id, arguments: args });
    ev("response.output_item.done", { output_index: o, item: { id, type: "function_call", call_id: callId, name: tc.name, arguments: args, status: "completed" } });
    o++;
  });
  const input = u.input ?? 10;
  ev("response.completed", {
    response: resp("completed", {
      usage: {
        input_tokens: input + (u.cacheRead ?? 0),
        output_tokens: u.output ?? 5,
        input_tokens_details: { cached_tokens: u.cacheRead ?? 0 },
        output_tokens_details: { reasoning_tokens: turn.thinking !== undefined ? 2 : 0 },
      },
    }),
  });
  return f;
}

function render(turn: FakeTurnSpec, idx: number): string[] {
  return openaiEvents(turn, idx).map((e) => sse(e.type, e));
}

/** Responses order: tools, instructions, input items. Caching is automatic (no breakpoints). */
export function openaiPrefix(body: any): PrefixModel {
  const blocks: string[] = [];
  for (const t of body.tools ?? []) blocks.push(JSON.stringify(t));
  blocks.push(JSON.stringify(body.instructions ?? ""));
  for (const i of body.input ?? []) blocks.push(JSON.stringify(i));
  return { blocks, breakpoints: [] };
}

export function startFakeOpenAI(script: FakeTurn[], opts: FakeOptions = {}): Promise<FakeServer> {
  return startFake(script, render, (_s, message) => ({ error: { message, type: "server_error", code: null } }),
    opts.simulateCache ? { model: openaiPrefix, sim: new PrefixCache("automatic") } : undefined);
}

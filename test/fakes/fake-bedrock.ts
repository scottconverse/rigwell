// Scripted fake Bedrock runtime: /model/<id>/converse-stream and /model/<id>/invoke-with-response-stream
// (Anthropic Messages events wrapped as event-stream chunks). Responses use the AWS event-stream framing.
import { encodeEventMessage } from "../../src/adapters/bedrock-auth.ts";
import { anthropicFrames } from "./fake-anthropic.ts";
import { splitChunks, type FakeServer, type FakeTurn, type FakeTurnSpec } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

export type FakeBedrockTurnSpec = FakeTurnSpec & {
  stopReason?: string;
  /** Send this event-stream exception after the first events instead of finishing, e.g. "throttlingException". */
  exception?: string;
  /** Signature sent with reasoning text. */
  reasoningSignature?: string;
};

export interface FakeBedrockServer extends FakeServer {
  /** Request paths, in order. */
  paths: string[];
}

const evt = (type: string, payload: unknown) => encodeEventMessage({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(payload));

function converseFrames(t: FakeTurnSpec, idx: number): Uint8Array[] {
  const turn = t as FakeBedrockTurnSpec;
  const f: Uint8Array[] = [evt("messageStart", { role: "assistant" })];
  let i = 0;
  if (turn.thinking !== undefined) {
    for (const c of splitChunks(turn.thinking)) f.push(evt("contentBlockDelta", { contentBlockIndex: i, delta: { reasoningContent: { text: c } } }));
    f.push(evt("contentBlockDelta", { contentBlockIndex: i, delta: { reasoningContent: { signature: turn.reasoningSignature ?? "sig-bedrock" } } }));
    f.push(evt("contentBlockStop", { contentBlockIndex: i })); i++;
  }
  if (turn.text !== undefined) {
    for (const c of splitChunks(turn.text)) f.push(evt("contentBlockDelta", { contentBlockIndex: i, delta: { text: c } }));
    f.push(evt("contentBlockStop", { contentBlockIndex: i })); i++;
  }
  (turn.toolCalls ?? []).forEach((tc, n) => {
    f.push(evt("contentBlockStart", { contentBlockIndex: i, start: { toolUse: { toolUseId: tc.id ?? `tooluse_fake_${idx}_${n}`, name: tc.name } } }));
    for (const c of splitChunks(JSON.stringify(tc.input), 3)) f.push(evt("contentBlockDelta", { contentBlockIndex: i, delta: { toolUse: { input: c } } }));
    f.push(evt("contentBlockStop", { contentBlockIndex: i })); i++;
  });
  if (turn.exception) return f; // handled by the caller
  f.push(evt("messageStop", { stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn") }));
  const u = turn.usage ?? {};
  f.push(evt("metadata", {
    usage: { inputTokens: u.input ?? 10, outputTokens: u.output ?? 5, totalTokens: (u.input ?? 10) + (u.output ?? 5), cacheReadInputTokens: u.cacheRead ?? 0, cacheWriteInputTokens: u.cacheCreation ?? 0 },
    metrics: { latencyMs: 1 },
  }));
  return f;
}

function anthropicChunks(t: FakeTurnSpec, idx: number): Uint8Array[] {
  return anthropicFrames(t, idx).map((frame) => {
    const json = frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    return evt("chunk", { bytes: Buffer.from(json).toString("base64") });
  });
}

export async function startFakeBedrock(script: FakeTurn[]): Promise<FakeBedrockServer> {
  const requests: any[] = [];
  const headers: Record<string, string>[] = [];
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => ({}));
      const idx = requests.length;
      requests.push(body);
      paths.push(url.pathname);
      const h: Record<string, string> = {};
      req.headers.forEach((v, k) => (h[k] = v));
      headers.push(h);
      const json = (status: number, o: unknown, extra: Record<string, string> = {}) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
      const entry = script[idx];
      if (!entry) return json(500, { message: `fake server: script exhausted (request #${idx + 1})` });
      const turn = (typeof entry === "function" ? entry(body, idx) : entry) as FakeBedrockTurnSpec;
      if (turn.status && turn.status >= 400) return json(turn.status, turn.errorBody ?? { message: `fake error ${turn.status}` }, turn.headers ?? {});
      const converse = url.pathname.endsWith("/converse-stream");
      let frames = converse ? converseFrames(turn, idx) : anthropicChunks(turn, idx);
      if (turn.breakMidStream) frames = frames.slice(0, Math.max(2, Math.ceil(frames.length / 2)));
      if (turn.exception && !converse) frames = frames.slice(0, -2); // no message_stop
      if (turn.exception) {
        frames.push(encodeEventMessage({ ":message-type": "exception", ":exception-type": turn.exception, ":content-type": "application/json" }, JSON.stringify({ message: "fake exception" })));
      }
      const stream = new ReadableStream({
        async start(c) {
          for (const f of frames) { c.enqueue(f); await Bun.sleep(0); }
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/vnd.amazon.eventstream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, headers, paths, stop: () => void server.stop(true) };
}

// Scripted fake Gemini server (streamGenerateContent?alt=sse).
import { splitChunks, startFake, type FakeServer, type FakeTurn, type FakeTurnSpec } from "./types.ts";
export type { FakeServer, FakeTurn } from "./types.ts";

export type FakeGoogleTurnSpec = FakeTurnSpec & {
  /** Attached to the first tool call (Gemini puts it on the first functionCall part). */
  thoughtSignature?: string;
  /** Attached to the text part when there are no tool calls. */
  textSignature?: string;
  finishReason?: string;
};

const data = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;

function render(t: FakeTurnSpec, idx: number): string[] {
  const turn = t as FakeGoogleTurnSpec;
  const f: string[] = [];
  const chunk = (parts: unknown[], extra: Record<string, unknown> = {}, finish?: string) =>
    f.push(data({ candidates: [{ content: { role: "model", parts }, index: 0, ...(finish ? { finishReason: finish } : {}) }], modelVersion: "fake", ...extra }));
  if (turn.thinking !== undefined) for (const c of splitChunks(turn.thinking)) chunk([{ text: c, thought: true }]);
  if (turn.text !== undefined) {
    const chunks = splitChunks(turn.text);
    chunks.forEach((c, i) => chunk([{ text: c, ...(turn.textSignature && i === chunks.length - 1 ? { thoughtSignature: turn.textSignature } : {}) }]));
  }
  (turn.toolCalls ?? []).forEach((tc, n) => {
    chunk([{ functionCall: { name: tc.name, args: tc.input, ...(tc.id ? { id: tc.id } : {}) }, ...(n === 0 && turn.thoughtSignature ? { thoughtSignature: turn.thoughtSignature } : {}) }]);
  });
  const u = turn.usage ?? {};
  f.push(data({
    candidates: [{ content: { role: "model", parts: [{ text: "" }] }, index: 0, finishReason: turn.finishReason ?? "STOP" }],
    usageMetadata: {
      promptTokenCount: (u.input ?? 10) + (u.cacheRead ?? 0), candidatesTokenCount: u.output ?? 5,
      cachedContentTokenCount: u.cacheRead ?? 0, ...(turn.thinking !== undefined ? { thoughtsTokenCount: 2 } : {}),
    },
  }));
  return f;
}

export function startFakeGoogle(script: FakeTurn[]): Promise<FakeServer> {
  return startFake(script, render, (status, message) => ({ error: { code: status, message, status: "INTERNAL" } }));
}

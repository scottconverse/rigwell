// In-process Session with a scripted model (no HTTP): captures every ModelRequest.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type SessionDeps } from "../../src/agent/session.ts";
import type { ContentBlock, Message, ModelConfig, ModelRequest, StreamEvent, TokenUsage } from "../../src/core/types.ts";
import { decide } from "../../src/permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../../src/permissions/lists.ts";
import { toolsForSession } from "../../src/tools/registry.ts";

export interface Reply { content: ContentBlock[]; usage?: Partial<TokenUsage> }
export type Respond = (req: ModelRequest, n: number) => Reply | Promise<Reply>;

export const MODEL: ModelConfig = {
  id: "custom:Stub-0", model: "stub", displayName: "Stub", provider: "anthropic", baseUrl: "http://127.0.0.1:1", maxContextLimit: 200_000,
};

export const text = (t: string): Reply => ({ content: [{ type: "text", text: t }] });
export const call = (name: string, input: Record<string, unknown>, id?: string): Reply => ({
  content: [{ type: "tool_use", id: id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`, name, input }],
});

export function makeStubSession(respond: Respond, over: Partial<SessionDeps> & { notes?: any[] } = {}) {
  const requests: ModelRequest[] = [];
  const stored: Message[] = [];
  const notes: any[] = over.notes ?? [];
  const cwd = mkdtempSync(join(tmpdir(), "rigwell-agent-test-"));
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  const model = over.resolveModel?.("x") ?? MODEL;
  const deps: SessionDeps = {
    id: crypto.randomUUID(), cwd,
    settings: { modelId: MODEL.id, reasoningEffort: "off", interactionMode: "auto", autonomyLevel: "high" },
    resolveModel: () => model,
    createAdapter: () => ({ stream: () => { throw new Error("stub adapter"); } }) as any,
    streamWithRetry: async function* (_a: unknown, req: ModelRequest): AsyncGenerator<StreamEvent> {
      requests.push(req);
      const r = await respond(req, requests.length - 1);
      const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, ...r.usage };
      yield { type: "message_done", content: r.content, stopReason: r.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage };
    } as any,
    toolsFor: toolsForSession, decide, lists: DEFAULT_COMMAND_LISTS,
    skipPermissions: false, autoRejectPermissionRequests: true, shell: "bash", retryBaseDelayMs: 1,
    persistence: {
      appendMessage: async (m) => { stored.push(m); },
      appendTurnOutcome: async () => {},
      saveSettings: async () => {},
    },
    ...over,
  };
  const session = new Session(deps, { notify: (n) => notes.push(n) });
  return { session, requests, stored, notes, cwd };
}

// Base-prompt budget (spec §6.4) and the token estimate used where no exact count exists.
import type { Message, ModelRequest } from "../core/types.ts";

/** chars / 4, rounded up. Used for the context breakdown and the budget test (no tokenizer ships with the build). */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * First-request budgets, in characters of the serialized Anthropic body parts. They are the sizes measured when
 * Phase 3 landed, plus about 10 percent. A change that pushes the first request past them must update the number
 * on purpose (test/agent/budget.test.ts fails otherwise).
 *
 * Measured at Phase 3 (fresh session at autonomy high, no MCP tools, skills or project files; chars):
 *   direct_only: system 5,102, tools 18,077 (Read Execute Grep Glob Edit Create load_tools call_tool Script script_job)
 *   script_only: system 5,360, tools 7,863 (Script script_job)
 * Context blocks (environment, session, todos) depend on the machine, so their cap is measured in an empty
 * non-git temp directory (533 chars at Phase 3) with room for longer OS and PATH strings.
 */
export const BASE_PROMPT_BUDGET = {
  direct_only: { systemChars: 5_620, toolsChars: 19_900 },
  script_only: { systemChars: 5_900, toolsChars: 8_650 },
  /** Environment + session + todos blocks of the first user message in an empty temp directory. */
  contextChars: 1_000,
} as const;

export function requestSizes(req: Pick<ModelRequest, "system" | "tools" | "messages">) {
  const systemChars = req.system.reduce((n, s) => n + s.length, 0);
  const toolsChars = JSON.stringify(req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length;
  return { systemChars, toolsChars, messagesChars: messagesChars(req.messages) };
}

export function messagesChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) for (const b of m.content) n += blockChars(b);
  return n;
}

export function blockChars(b: Message["content"][number]): number {
  switch (b.type) {
    case "text": return b.text.length;
    case "thinking": return b.thinking.length;
    case "tool_use": return b.name.length + JSON.stringify(b.input).length;
    case "tool_result": return b.content.length;
  }
}

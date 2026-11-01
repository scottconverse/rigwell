// Context breakdown by category (spec §6.4 / §13.6). Estimated tokens: characters / 4.
import type { Message, ModelRequest } from "../core/types.ts";
import { blockChars, estimateTokens } from "./budget.ts";

export const CONTEXT_CATEGORIES = [
  "systemPrompt", "tools", "mcpTools", "userInfo", "agentsMd", "customAgents", "skills", "messages",
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export type ContextBreakdown = Record<ContextCategory, number>;

const DEFERRED_NOTICE = /^<system-reminder>\n(Deferred tools|Tools loaded)/;

function categoryOfText(text: string): ContextCategory | null {
  if (text.startsWith("<environment>") || text.startsWith("<session>") || text.startsWith("<todos>")) return "userInfo";
  if (text.startsWith("<project_instructions>")) return "agentsMd";
  if (text.startsWith("<skills>")) return "skills";
  if (/^<(custom_agents|subagents|agents)\b/.test(text)) return "customAgents";
  if (DEFERRED_NOTICE.test(text)) return "mcpTools";
  return null;
}

/** Estimated tokens per category for a request as it would be sent now. */
export function contextBreakdown(req: Pick<ModelRequest, "system" | "tools" | "messages">): ContextBreakdown {
  const chars = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as ContextBreakdown;
  chars.systemPrompt = req.system.reduce((n, s) => n + s.length, 0);
  for (const t of req.tools) {
    const n = t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
    // Tools reached through load_tools / Script bindings count as MCP tools once they are announced; the array
    // itself only holds native tools unless a name looks like server__tool.
    chars[t.name.includes("__") ? "mcpTools" : "tools"] += n;
  }
  for (const m of req.messages as Message[]) {
    for (const b of m.content) {
      const cat = b.type === "text" ? categoryOfText(b.text) ?? "messages" : "messages";
      chars[cat] += blockChars(b);
    }
  }
  return Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, estimateTokens(chars[c])])) as ContextBreakdown;
}

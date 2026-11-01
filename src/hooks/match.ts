// Matcher rules (spec §5.6 Config).
import type { HookEventName, HookGroup } from "./config.ts";

/** Events whose matcher value exists. Others run every hook regardless of `matcher`. */
export const MATCHER_VALUE_EVENTS: readonly HookEventName[] = ["SessionStart", "PreToolUse", "PostToolUse"];

/** Empty/missing/`*` matches all; else exact match first, then regex; a bad regex never matches. */
export function matcherMatches(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (matcher === value) return true;
  try { return new RegExp(matcher).test(value); } catch { return false; }
}

export interface MatchContext {
  /** Tool name (Pre/PostToolUse) or source (SessionStart). */
  value?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export function groupApplies(event: HookEventName, group: HookGroup, ctx: MatchContext): boolean {
  if (group.commandRegex !== undefined) {
    // Only for the Execute tool; other tools skip a config that has it.
    if (ctx.toolName !== "Execute") return false;
    const cmd = typeof ctx.toolInput?.command === "string" ? ctx.toolInput.command : "";
    try { if (!new RegExp(group.commandRegex).test(cmd)) return false; } catch { return false; }
  }
  if (!MATCHER_VALUE_EVENTS.includes(event)) return true;
  return matcherMatches(group.matcher, ctx.value ?? "");
}

export function selectGroups(event: HookEventName, groups: HookGroup[] | undefined, ctx: MatchContext): HookGroup[] {
  return (groups ?? []).filter((g) => groupApplies(event, g, ctx));
}

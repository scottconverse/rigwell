// Base-prompt budget (spec §6.4): the first request must not grow past the numbers in src/agent/budget.ts.
import { describe, expect, test } from "bun:test";
import { BASE_PROMPT_BUDGET, requestSizes } from "../../src/agent/budget.ts";
import { contextBreakdown } from "../../src/agent/context-stats.ts";
import { makeStubSession, text } from "./helpers.ts";

describe("first request budget", () => {
  for (const mode of ["direct_only", "script_only"] as const) {
    test(`${mode}: system, tools and context stay within budget`, async () => {
      const s = makeStubSession(() => text("ok"), { toolExecutionModeOverride: mode });
      s.session.addUserMessage("hi");
      await s.session.settled();
      const req = s.requests[0]!;
      const sizes = requestSizes(req);
      const ctx = req.messages[0]!.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
      const b = BASE_PROMPT_BUDGET[mode];
      expect(sizes.systemChars).toBeLessThanOrEqual(b.systemChars);
      expect(sizes.toolsChars).toBeLessThanOrEqual(b.toolsChars);
      expect(ctx).toBeLessThanOrEqual(BASE_PROMPT_BUDGET.contextChars);
    });
  }

  test("the budget is tight: within 15 percent above the measured size, so a shrink is noticed too", async () => {
    const s = makeStubSession(() => text("ok"), { toolExecutionModeOverride: "direct_only" });
    s.session.addUserMessage("hi");
    await s.session.settled();
    const sizes = requestSizes(s.requests[0]!);
    expect(BASE_PROMPT_BUDGET.direct_only.toolsChars / sizes.toolsChars).toBeLessThan(1.15);
    expect(BASE_PROMPT_BUDGET.direct_only.systemChars / sizes.systemChars).toBeLessThan(1.15);
  });

  test("context breakdown covers every category and puts tools and system first", async () => {
    const s = makeStubSession(() => text("ok"));
    s.session.addUserMessage("hi");
    await s.session.settled();
    const b = contextBreakdown(s.requests[0]!);
    expect(Object.keys(b).sort()).toEqual(["agentsMd", "customAgents", "mcpTools", "messages", "skills", "systemPrompt", "tools", "userInfo"]);
    expect(b.systemPrompt).toBeGreaterThan(1000);
    expect(b.tools).toBeGreaterThan(b.systemPrompt);
    expect(b.userInfo).toBeGreaterThan(50);
    expect(b.messages).toBeGreaterThan(0);
    expect(b.mcpTools + b.agentsMd + b.skills + b.customAgents).toBe(0);
  });
});

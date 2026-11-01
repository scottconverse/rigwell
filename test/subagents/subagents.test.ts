import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import {
  TaskError, TaskLimits, agentCatalog, isStarted, loadAgents, parseAgentFile, runTask,
  type ChildOptions, type ChildOutcome, type ParentContext,
} from "../../src/subagents/index.ts";

let env: ReturnType<typeof tmpEnv>;
let proj: string;
beforeEach(() => { env = tmpEnv(); proj = path.join(env.root, "proj"); mkdirSync(path.join(proj, ".git"), { recursive: true }); });
afterEach(() => env.cleanup());

const put = (dir: string, file: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, file), text); };
const parent = (o: Partial<ParentContext> = {}): ParentContext =>
  ({ sessionId: "root", rootSessionId: "root", depth: 0, cwd: proj, modelId: "m-parent", reasoningEffort: "high", autonomy: "medium", ...o });
const ok = (report = "done"): ChildOutcome => ({ childSessionId: "c1", status: "completed", report, toolUseCount: 3, durationMs: 5 });

test("agent files: frontmatter, defaults, normalization, project before personal, bad model -> inherit", () => {
  put(path.join(proj, ".rigwell", "agents"), "Reviewer.md", "---\nname: Code Reviewer\ndescription: Reviews code\nmodel: gpt-x\ntools: Read, Grep\nreasoningEffort: low\nmcpServers: a, b\n---\nYou review code.\n");
  put(path.join(env.rigwellHome, "agents"), "code-reviewer.md", "---\ndescription: personal dup\n---\nPersonal body");
  put(path.join(env.rigwellHome, "agents"), "plain.md", "No frontmatter, body is the prompt");
  put(path.join(env.rigwellHome, "agents"), "broken.md", "---\nname: [oops\n  bad: : yaml\n---\nbody");
  put(path.join(env.rigwellHome, "agents"), "notes.txt", "ignored");
  const { agents, shadowed } = loadAgents({ cwd: proj, homeDir: env.home, isValidModel: (m) => m === "ok-model" });
  const by = Object.fromEntries(agents.map((a) => [a.name, a]));
  expect(Object.keys(by).sort()).toEqual(["broken", "code-reviewer", "plain"]);
  expect(by["code-reviewer"]).toMatchObject({
    displayName: "Code Reviewer", description: "Reviews code", model: "inherit", reasoningEffort: "low",
    tools: ["Read", "Grep"], mcpServers: ["a", "b"], systemPrompt: "You review code.", location: "project",
  });
  expect(shadowed.map((a) => a.location)).toEqual(["personal"]);
  expect(by.plain).toMatchObject({ model: "inherit", description: "", systemPrompt: "No frontmatter, body is the prompt" });
  expect(agentCatalog([by["code-reviewer"]])).toEqual(["code-reviewer: Reviews code"]);
  expect(parseAgentFile("/x/a.md", "---\nmodel: ok-model\n---\nb", "personal")!.model).toBe("ok-model");
});

test("runTask foreground: brief from prompt only, model inherit, tools minus Task, read-only autonomy cap", async () => {
  put(path.join(proj, ".rigwell", "agents"), "scout.md", "---\nname: scout\ndescription: d\ntools: Read, Grep, Task\nmodel: m-scout\n---\nScout prompt");
  const { agents } = loadAgents({ cwd: proj, homeDir: env.home });
  let seen: { prompt: string; opts: ChildOptions } | undefined;
  const res = await runTask({ description: "scan repo", prompt: "Find X", agent: "Scout" }, {
    parent: parent({ autonomy: "high" }), agents, limits: new TaskLimits(),
    spawnChild: async (prompt, opts) => { seen = { prompt, opts }; return ok("the report"); },
  });
  expect(isStarted(res)).toBe(false);
  if (isStarted(res)) return;
  expect(res.report).toBe("the report");
  expect(res.summary).toEqual({ childSessionId: "c1", subagentType: "scout", description: "scan repo", status: "completed", toolUseCount: 3, durationMs: 5 });
  expect(seen!.prompt).toBe("Find X");
  expect(seen!.opts).toMatchObject({
    parentSessionId: "root", depth: 1, modelId: "m-scout", reasoningEffort: "high", autonomy: "low",
    allowedTools: ["Read", "Grep"], removeTools: ["Task"], agentSystemPrompt: "Scout prompt", inactivityTimeoutMs: 900000,
  });
  // general agent inherits the parent's model and autonomy
  await runTask({ description: "d", prompt: "p" }, { parent: parent(), agents, limits: new TaskLimits(), spawnChild: async (_p, o) => { seen = { prompt: _p, opts: o }; return ok(); } });
  expect(seen!.opts).toMatchObject({ modelId: "m-parent", autonomy: "medium", allowedTools: undefined, agentName: undefined });
});

test("runTask errors: depth, unknown agent, invalid input, child failure becomes a failed report", async () => {
  const deps = (o: object = {}) => ({ parent: parent(), agents: [], limits: new TaskLimits(), spawnChild: async () => ok(), ...o });
  await expect(runTask({ description: "d", prompt: "p" }, deps({ parent: parent({ depth: 1 }) }))).rejects.toMatchObject({ code: "depth" });
  await expect(runTask({ description: "d", prompt: "p", agent: "nope" }, deps())).rejects.toMatchObject({ code: "unknown_agent" });
  await expect(runTask({ description: "d", prompt: " " }, deps())).rejects.toBeInstanceOf(TaskError);
  const failed = await runTask({ description: "d", prompt: "p" }, deps({ spawnChild: async () => { throw new Error("boom"); } }));
  if (isStarted(failed)) throw new Error("unexpected");
  expect(failed.summary.status).toBe("failed");
  expect(failed.report).toContain("boom");
});

test("limits: 5 per root, 10 per process, release on completion, clamps", async () => {
  const limits = new TaskLimits();
  expect([limits.perRoot, limits.perProcess, limits.maxDepth]).toEqual([5, 10, 1]);
  const big = new TaskLimits({ perRoot: 999, perProcess: 999, maxDepth: 5 });
  expect([big.perRoot, big.perProcess, big.maxDepth]).toEqual([25, 100, 1]);
  const gates: (() => void)[] = [];
  const spawn = () => new Promise<ChildOutcome>((res) => gates.push(() => res(ok())));
  const start = (root: string) => runTask({ description: "d", prompt: "p", background: true }, { parent: parent({ sessionId: root, rootSessionId: root }), agents: [], limits, spawnChild: spawn });
  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(await start("r1"));
  expect(limits.active("r1")).toBe(5);
  await expect(start("r1")).rejects.toMatchObject({ code: "limit" });
  for (let i = 0; i < 5; i++) jobs.push(await start("r2"));
  await expect(start("r3")).rejects.toThrow(/Wait for a task to finish/);
  expect(limits.active()).toBe(10);
  gates.shift()!();
  const first = jobs[0];
  if (!isStarted(first)) throw new Error("expected background");
  expect(first.jobId).toMatch(/^task-/);
  expect((await first.done).report).toBe("done");
  expect(limits.active("r1")).toBe(4);
  await start("r3"); // a slot freed
  gates.forEach((g) => g());
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { jsCommand, sleepCommand } from "../platform.ts";
import {
  HookRunner, aggregatePreToolUse, aggregateStop, aggregateUserPromptSubmit, aggregatePreCompact, groupApplies,
  loadHooksConfig, makeResult, matcherMatches, parseEnvFile, runHooks, type HookNotification, type HooksConfig,
} from "../../src/hooks/index.ts";

let env: ReturnType<typeof tmpEnv>;
let proj: string;
beforeEach(() => {
  env = tmpEnv();
  proj = path.join(env.root, "proj");
  mkdirSync(path.join(proj, ".git"), { recursive: true });
});
afterEach(() => env.cleanup());

const cfgOf = (events: HooksConfig["events"], extra: Partial<HooksConfig> = {}): HooksConfig =>
  ({ hooksDisabled: false, showHookOutput: true, events, warnings: [], ...extra });
const cmd = (command: string, extra: object = {}) => ({ type: "command" as const, command, ...extra });
const base = () => ({ session_id: "s1", transcript_path: "/t.jsonl", cwd: proj, permission_mode: "off" as const });
const res = (exitCode: number, stdout = "", stderr = "", extra: object = {}) => makeResult({ command: "x", exitCode, stdout, stderr, ...extra });

test("matcher: empty/*/exact/regex/bad regex", () => {
  expect(matcherMatches(undefined, "Edit")).toBe(true);
  expect(matcherMatches("*", "Edit")).toBe(true);
  expect(matcherMatches("Edit", "Edit")).toBe(true);
  expect(matcherMatches("Edit|Create", "Create")).toBe(true);
  expect(matcherMatches("Edit", "Create")).toBe(false);
  expect(matcherMatches("([", "([")).toBe(true); // exact first
  expect(matcherMatches("([", "x")).toBe(false);
});

test("commandRegex only for Execute; events without a match value ignore matcher", () => {
  const g = { matcher: "Execute", commandRegex: "^git push", hooks: [cmd("true")] };
  expect(groupApplies("PreToolUse", g, { value: "Execute", toolName: "Execute", toolInput: { command: "git push -f" } })).toBe(true);
  expect(groupApplies("PreToolUse", g, { value: "Execute", toolName: "Execute", toolInput: { command: "ls" } })).toBe(false);
  expect(groupApplies("PreToolUse", { ...g, matcher: undefined }, { value: "Edit", toolName: "Edit", toolInput: {} })).toBe(false);
  expect(groupApplies("Stop", { matcher: "nope", hooks: [cmd("true")] }, {})).toBe(true);
});

test("config: levels concatenate, hooks.json replaces settings per event, flags first-set", () => {
  writeJson(path.join(env.rigwellHome, "settings.json"), { hooks: { PreToolUse: [{ hooks: [cmd("user-settings")] }], Stop: [{ hooks: [cmd("user-stop")] }], showHookOutput: false } });
  writeJson(path.join(env.rigwellHome, "hooks.json"), { PreToolUse: [{ hooks: [cmd("user-json")] }] });
  writeJson(path.join(proj, ".rigwell", "hooks.json"), { PreToolUse: [{ matcher: "Edit", hooks: [cmd("proj")] }] });
  const c = loadHooksConfig({ cwd: proj, homeDir: env.home });
  expect(c.events.PreToolUse!.map((g) => g.hooks[0].command)).toEqual(["proj", "user-json"]); // project first, user-settings replaced
  expect(c.events.Stop!.map((g) => g.hooks[0].command)).toEqual(["user-stop"]);
  expect(c.showHookOutput).toBe(false);
  expect(c.hooksDisabled).toBe(false);
  expect(loadHooksConfig({ cwd: proj, homeDir: env.home, trustProject: false }).events.PreToolUse!.length).toBe(1);
  writeJson(path.join(proj, ".rigwell", "settings.local.json"), { hooksDisabled: true });
  expect(loadHooksConfig({ cwd: proj, homeDir: env.home }).hooksDisabled).toBe(true);
  expect(loadHooksConfig({ cwd: proj, homeDir: env.home, allowManagedHooksOnly: true }).events).toEqual({});
});

test("runner: stdin JSON, parallel, config order, timeout, notifications", async () => {
  const seen: HookNotification[] = [];
  const out = path.join(env.root, "stdin.json");
  const cfg = cfgOf({
    PreToolUse: [
      { matcher: "Edit", hooks: [cmd(jsCommand(env.root, `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { require("fs").writeFileSync(${JSON.stringify(out)}, s); console.log(JSON.stringify({ decision: "block", reason: "nope" })); });`))] },
      { hooks: [cmd(sleepCommand(env.root, 5), { timeout: 0.3 }), cmd(jsCommand(env.root, `console.error("hi"); process.exit(2);`))] },
    ],
  });
  const t0 = Date.now();
  const r = await runHooks(cfg, "PreToolUse", base(), { tool_name: "Edit", tool_input: { a: 1 } },
    { matchValue: "Edit", toolName: "Edit", toolInput: { a: 1 }, toolCallId: "tc1", notify: (n) => seen.push(n) });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.results.map((x) => x.exitCode)).toEqual([0, 1, 2]);
  expect(r.results[1].timedOut).toBe(true);
  const stdin = JSON.parse(await Bun.file(out).text());
  expect(stdin).toMatchObject({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { a: 1 }, permission_mode: "off" });
  const started = seen.filter((n) => n.type === "hook_execution_started");
  const done = seen.filter((n) => n.type === "hook_execution_completed");
  expect(started.length).toBe(2); expect(done.length).toBe(2);
  expect(started[0]).toMatchObject({ hookEventName: "PreToolUse", hookToolCallId: "tc1", hookMatcher: "Edit", isParallelExecution: true, hookOrder: 0 });
  expect((started[0] as any).parallelGroupId).toBe((started[1] as any).parallelGroupId);
  expect(done[1]).toMatchObject({ hookStatus: "error", hookPreventedAction: true });
  const o = aggregatePreToolUse(r.results);
  expect(o.decision).toBe("deny"); expect(o.reason).toBe("nope"); // config order: first deny wins
});

test("runner: hooksDisabled and no match do nothing", async () => {
  const cfg = cfgOf({ Stop: [{ hooks: [cmd("exit 2")] }] }, { hooksDisabled: true });
  expect((await runHooks(cfg, "Stop", base(), {})).ran).toBe(false);
  const cfg2 = cfgOf({ PreToolUse: [{ matcher: "Edit", hooks: [cmd("exit 2")] }] });
  expect((await runHooks(cfg2, "PreToolUse", base(), {}, { matchValue: "Read", toolName: "Read" })).ran).toBe(false);
});

test("runner: abort signal counts as exit 1", async () => {
  const ac = new AbortController();
  const cfg = cfgOf({ Stop: [{ hooks: [cmd(sleepCommand(env.root, 5))] }] });
  const p = runHooks(cfg, "Stop", base(), {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const r = await p;
  expect(r.results[0].exitCode).toBe(1);
});

test("PreToolUse outcomes", () => {
  expect(aggregatePreToolUse([]).decision).toBe("none");
  expect(aggregatePreToolUse([res(3, "", "boom")])).toMatchObject({ decision: "abort", reason: "boom" });
  expect(aggregatePreToolUse([res(0, '{"continue":false,"stopReason":"halt"}')])).toMatchObject({ decision: "stop", reason: "halt" });
  expect(aggregatePreToolUse([res(2, "", "no push")])).toMatchObject({ decision: "deny", reason: "no push" });
  const allow = aggregatePreToolUse([res(0, '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"ls"}}}')], { command: "rm", cwd: "/" });
  expect(allow).toMatchObject({ decision: "allow", updatedInput: { command: "ls", cwd: "/" }, rerunChecks: false });
  const mod = aggregatePreToolUse([res(0, '{"hookSpecificOutput":{"updatedInput":{"command":"ls"}}}', "", { preserveRiskLevel: true })], { command: "rm" });
  expect(mod).toMatchObject({ decision: "none", updatedInput: { command: "ls" }, rerunChecks: true, preserveRiskLevel: true });
  expect(aggregatePreToolUse([res(0, '{"hookSpecificOutput":{"permissionDecision":"ask"}}')]).decision).toBe("ask");
  expect(aggregatePreToolUse([res(1, "", "warn")]).warnings).toEqual(["warn"]);
  // context only on exit 0
  expect(aggregatePreToolUse([res(0, "plain ctx"), res(1, "ignored")]).additionalContext).toBe("plain ctx");
});

test("Stop, UserPromptSubmit, PreCompact outcomes", () => {
  expect(aggregateStop([res(2, "", "keep going")]).continueWith).toBe("keep going");
  expect(aggregateStop([res(0, '{"decision":"block","reason":"tests?"}')]).continueWith).toBe("tests?");
  expect(aggregateStop([res(0, '{"continue":false,"stopReason":"done"}')]).stop).toBe("done");
  expect(aggregateStop([res(3, "", "x")]).abort).toBe("x");
  expect(aggregateUserPromptSubmit([res(2, "", "bad prompt")])).toMatchObject({ blocked: true, reason: "bad prompt" });
  expect(aggregateUserPromptSubmit([res(0, '{"hookSpecificOutput":{"updatedInput":{"prompt":"p2"},"additionalContext":"c"}}')])).toMatchObject({ blocked: false, prompt: "p2", additionalContext: "c" });
  expect(aggregatePreCompact([res(2, "", "no")], "manual").cancel).toBe(true);
  expect(aggregatePreCompact([res(2, "", "no")], "auto").cancel).toBe(false);
});

test("env file parsing", () => {
  expect(parseEnvFile('export A=1\nexport B="two words"\nnoise\n')).toEqual({ A: "1", B: "two words" });
});

test("HookRunner: Stop tracks stop_hook_active; SessionStart collects env + context", async () => {
  const log = path.join(env.root, "stops.log");
  const cfg = cfgOf({
    Stop: [{ hooks: [cmd(jsCommand(env.root, `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { require("fs").appendFileSync(${JSON.stringify(log)}, s + "\\n"); console.error("again"); process.exit(2); });`))] }],
    SessionStart: [{ matcher: "startup", hooks: [cmd(jsCommand(env.root, `require("fs").appendFileSync(process.env.CLAUDE_ENV_FILE, "export FOO=bar\\n"); console.log("ctx-line");`))] }],
  });
  const hr = new HookRunner({ config: cfg, sessionId: "s1", transcriptPath: "/t", cwd: proj, permissionMode: () => "auto-low" });
  const a = await hr.stop({ toolExecutionCount: 2, elapsedMs: 10 });
  expect(a.continueWith).toBe("again");
  await hr.stop({ toolExecutionCount: 2, elapsedMs: 10 });
  const lines = (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.stop_hook_active)).toEqual([false, true]);
  expect(lines[0].permission_mode).toBe("auto-low");
  hr.resetStop();
  const s = await hr.sessionStart("startup");
  expect(s.envVars).toEqual({ FOO: "bar" });
  expect(s.additionalContext).toBe("ctx-line");
  expect((await hr.sessionStart("resume")).additionalContext).toBe("");
});

// Phase 1 done-when test: a scripted prompt edits a repo end to end via `rigwell exec`,
// and the same task passes on both providers (against local fake servers).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeChat } from "../fakes/fake-chat.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer } from "../fakes/types.ts";
import { CLI, RpcChild, fixBugScript, makeHome, makeRepo } from "./helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const PROVIDERS = [
  { provider: "anthropic" as const, start: startFakeAnthropic, modelId: "custom:Fake-Anthropic-0" },
  { provider: "openai" as const, start: startFakeOpenAI, modelId: "custom:Fake-OpenAI-0" },
  { provider: "generic-chat-completion-api" as const, start: startFakeChat, modelId: "custom:Fake-Chat-0" },
];

describe.each(PROVIDERS)("exec end to end: $provider", ({ provider, start, modelId }) => {
  test("stream-jsonrpc: fix a bug with Read, Edit, Execute", async () => {
    const server = await start(fixBugScript());
    servers.push(server);
    const repo = makeRepo();
    const name = provider === "anthropic" ? "Fake Anthropic" : provider === "openai" ? "Fake OpenAI" : "Fake Chat";
    const home = makeHome([{ provider, url: server.url, displayName: name }]);

    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", "low"], { cwd: repo, env: { RIGWELL_HOME: home } });
    const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId });
    expect(init.settings.autonomyLevel).toBe("low");
    expect(await c.call("add_user_message", { text: "check.js fails. Fix the bug.", messageId: "turn-1" })).toEqual({});
    const done = await c.turnCompleted();
    await c.call("close_session", { reason: "other" });
    expect(await c.close()).toBe(0);

    expect(done.params.notification.reason).toBe("completed");
    expect(done.params.notification.turnId).toBe("turn-1");
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain('"Hello, "');
    expect(execFileSync("node", ["check.js"], { cwd: repo, encoding: "utf8" })).toContain("PASS");
    expect(server.requests.length).toBe(4);

    // Wire shape (spec §3.1): settings_updated before the init response, every notification has sessionId.
    const iSettings = c.messages.findIndex((m) => m.params?.notification?.type === "settings_updated");
    const iInit = c.messages.findIndex((m) => m.type === "response" && m.result?.sessionId);
    expect(iSettings).toBeGreaterThanOrEqual(0);
    expect(iSettings).toBeLessThan(iInit);
    const notifs = c.messages.filter((m) => m.method === "rigwell.session_notification");
    expect(notifs.slice(1).every((m) => m.params.sessionId === init.sessionId)).toBe(true);
    const types = new Set(c.notifications().map((n) => n.type));
    for (const t of ["assistant_text_delta", "assistant_text_complete", "tool_call", "tool_execution_phase_changed",
      "tool_progress_update", "tool_result", "agent_working_state_changed", "session_token_usage_changed", "agent_turn_completed"]) {
      expect(types.has(t)).toBe(true);
    }
    expect(c.messages.every((m) => m.jsonrpc === "2.0" && typeof m.type === "string")).toBe(true);

    // Transcript persisted (spec §12.1).
    const sessions = join(home, "sessions");
    const slugDir = readdirSync(sessions).find((d) => d.startsWith("-"))!;
    const lines = readFileSync(join(sessions, slugDir, `${init.sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("session_start");
    expect(lines.filter((l) => l.type === "message").length).toBe(9); // context, prompt, 4 assistant, 3 tool results
    expect(lines.at(-1)).toMatchObject({ type: "agent_turn_outcome", turnId: "turn-1", reason: "completed" });
    const settings = JSON.parse(readFileSync(join(sessions, slugDir, `${init.sessionId}.settings.json`), "utf8"));
    expect(settings.model).toBe(modelId);
    expect(settings.providerLock).toBe(provider);
  }, 30000);

  test("prompt mode: rigwell exec --auto low \"<prompt>\"", async () => {
    const server = await start(fixBugScript());
    servers.push(server);
    const repo = makeRepo();
    const home = makeHome([{ provider, url: server.url, displayName: provider === "anthropic" ? "Fake Anthropic" : provider === "openai" ? "Fake OpenAI" : "Fake Chat" }]);
    const p = Bun.spawn(["bun", CLI, "exec", "--auto", "low", "check.js fails. Fix the bug."], { cwd: repo, env: { ...process.env, RIGWELL_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = [await new Response(p.stdout).text(), await p.exited];
    expect(code).toBe(0);
    expect(out).toContain("Fixed the typo in greet.js");
    expect(execFileSync("node", ["check.js"], { cwd: repo, encoding: "utf8" })).toContain("PASS");
  }, 30000);
});

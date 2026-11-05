// Phase 1 done-when test: a scripted prompt edits a repo end to end via `rigwell exec`,
// and the same task passes on both providers (against local fake servers).
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeBedrock } from "../fakes/fake-bedrock.ts";
import { startFakeChat } from "../fakes/fake-chat.ts";
import { startFakeGoogle } from "../fakes/fake-google.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import { startFakeOpenAIWs } from "../fakes/fake-openai-ws.ts";
import type { FakeServer } from "../fakes/types.ts";
import { CLI, RpcChild, fixBugScript, makeHome, makeRepo } from "./helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

type Row = {
  label: string; provider: "anthropic" | "openai" | "generic-chat-completion-api" | "google" | "bedrock-converse";
  start: (script: any) => Promise<FakeServer>; modelId: string; name: string; extra?: Record<string, unknown>; env?: Record<string, string>;
  /** Extra checks on the fake after the run. */
  check?: (server: any) => void;
};
const BEDROCK = { awsRegion: "us-east-1" };
const PROVIDERS: Row[] = [
  { label: "anthropic", provider: "anthropic", start: startFakeAnthropic, modelId: "custom:Fake-Anthropic-0", name: "Fake Anthropic" },
  { label: "openai", provider: "openai", start: startFakeOpenAI, modelId: "custom:Fake-OpenAI-0", name: "Fake OpenAI" },
  { label: "generic-chat-completion-api", provider: "generic-chat-completion-api", start: startFakeChat, modelId: "custom:Fake-Chat-0", name: "Fake Chat" },
  { label: "google", provider: "google", start: startFakeGoogle, modelId: "custom:Fake-Google-0", name: "Fake Google" },
  { label: "bedrock-converse", provider: "bedrock-converse", start: startFakeBedrock, modelId: "custom:Fake-Converse-0", name: "Fake Converse", extra: { bedrock: BEDROCK },
    check: (s) => expect(s.paths.every((p: string) => p.endsWith("/converse-stream"))).toBe(true) },
  { label: "bedrock anthropic", provider: "anthropic", start: startFakeBedrock, modelId: "custom:Fake-Bedrock-Claude-0", name: "Fake Bedrock Claude", extra: { bedrock: BEDROCK },
    check: (s) => expect(s.paths.every((p: string) => p.endsWith("/invoke-with-response-stream"))).toBe(true) },
  { label: "bedrock openai", provider: "openai", start: startFakeOpenAI, modelId: "custom:Fake-Bedrock-GPT-0", name: "Fake Bedrock GPT", extra: { bedrock: BEDROCK } },
  // Responses over WebSocket: "force" skips the OpenAI-base-URL check so the fake can stand in for it.
  { label: "openai websocket", provider: "openai", start: (s) => startFakeOpenAIWs(s), modelId: "custom:Fake-OpenAI-WS-0", name: "Fake OpenAI WS", env: { RIGWELL_OPENAI_WEBSOCKET: "force" },
    check: (s) => { expect(s.upgrades).toBe(1); expect(s.httpRequests.length).toBe(0); expect(s.frames.slice(1).every((f: any) => f.previous_response_id)).toBe(true); } },
];

describe.each(PROVIDERS)("exec end to end: $label", ({ provider, start, modelId, name, extra, env, check }) => {
  test("stream-jsonrpc: fix a bug with Read, Edit, Execute", async () => {
    const server = await start(fixBugScript());
    servers.push(server);
    const repo = makeRepo();
    const home = makeHome([{ provider, url: server.url, displayName: name, extra }]);

    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", "low"], { cwd: repo, env: { RIGWELL_HOME: home, ...(env ?? {}) } });
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
    check?.(server);

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
    const home = makeHome([{ provider, url: server.url, displayName: name, extra }]);
    const p = Bun.spawn(["bun", CLI, "exec", "--auto", "low", "check.js fails. Fix the bug."], { cwd: repo, env: { ...process.env, RIGWELL_HOME: home, ...(env ?? {}) }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = [await new Response(p.stdout).text(), await p.exited];
    expect(code).toBe(0);
    expect(out).toContain("Fixed the typo in greet.js");
    expect(execFileSync("node", ["check.js"], { cwd: repo, encoding: "utf8" })).toContain("PASS");
  }, 30000);

  test("prompt mode: a [tool] line starts on its own line when stdout and stderr share one terminal", async () => {
    const server = await start(fixBugScript());
    servers.push(server);
    const repo = makeRepo();
    const home = makeHome([{ provider, url: server.url, displayName: name, extra }]);
    const outFile = join(repo, "..", `exec-out-${Date.now()}.txt`);
    const fd = openSync(outFile, "w");
    try {
      const p = Bun.spawn(["bun", CLI, "exec", "--auto", "low", "check.js fails. Fix the bug."], { cwd: repo, env: { ...process.env, RIGWELL_HOME: home, ...(env ?? {}) }, stdout: fd, stderr: fd });
      expect(await p.exited).toBe(0);
    } finally { closeSync(fd); }
    const lines = readFileSync(outFile, "utf8").split(/\r?\n/);
    expect(lines).toContain("I'll look at the code.");
    expect(lines.some((l) => l.startsWith("[tool] ok "))).toBe(true);
    expect(lines.filter((l) => l.includes("[tool]")).every((l) => l.startsWith("[tool]"))).toBe(true);
  }, 30000);
});

// Final gap wave, small fields: SessionStart ids, model_content, streaming_input, backgroundWork, Responses profile fields.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenAIBody, isOpenAIBaseUrl } from "../../src/adapters/openai.ts";
import { capForModel, MODEL_RESULT_CHARS } from "../../src/agent/session.ts";
import { resolveProfile } from "../../src/agent/profiles.ts";
import { HookRunner, loadHooksConfig } from "../../src/hooks/index.ts";
import type { ModelConfig, ModelRequest, Tool } from "../../src/core/types.ts";
import { appendMessage, createSession, loadTranscript } from "../../src/storage/transcript.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { call, makeStubSession, text } from "../agent/helpers.ts";
import { driver } from "./helpers.ts";

const servers: FakeServer[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); });

async function setup(turns: FakeTurn[]) {
  const model = await startFakeAnthropic(turns);
  servers.push(model);
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
  return { model, repo: makeRepo() };
}

describe("SessionStart hook input", () => {
  test("previous_session_id and calling_session_id reach the hook's stdin", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "rigwell-ss-")), "stdin.json");
    const hooks = (a: any) => new HookRunner({
      config: loadHooksConfig({ cwd: a.cwd ?? process.cwd(), extra: { SessionStart: [{ hooks: [{ type: "command", command: `cat > ${out}` }] }] } }),
      sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd: process.cwd(), permissionMode: a.permissionMode, notify: a.notify,
    });
    const { session } = makeStubSession(() => text("ok"), { hooksFor: hooks, previousSessionId: "prev-1", callingSessionId: "call-1" });
    session.start("resume");
    session.addUserMessage("go");
    await session.idle();
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ hook_event_name: "SessionStart", source: "resume", previous_session_id: "prev-1", calling_session_id: "call-1" });

    const plain = join(mkdtempSync(join(tmpdir(), "rigwell-ss-")), "stdin.json");
    const hooks2 = (a: any) => new HookRunner({
      config: loadHooksConfig({ cwd: a.cwd ?? process.cwd(), extra: { SessionStart: [{ hooks: [{ type: "command", command: `cat > ${plain}` }] }] } }),
      sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd: process.cwd(), permissionMode: a.permissionMode, notify: a.notify,
    });
    const b = makeStubSession(() => text("ok"), { hooksFor: hooks2 });
    b.session.start("startup");
    b.session.addUserMessage("go");
    await b.session.idle();
    const j = JSON.parse(readFileSync(plain, "utf8"));
    expect(j.source).toBe("startup");
    expect(j.previous_session_id).toBeUndefined();
    expect(j.calling_session_id).toBeUndefined();
  });

  test("a resumed session passes its fork parent (or itself), a spawned one its caller", async () => {
    const { model, repo } = await setup([{ text: "a" }]);
    const dumps = join(mkdtempSync(join(tmpdir(), "rigwell-ss-")), "in.json");
    const proj = join(repo, ".rigwell");
    Bun.spawnSync(["mkdir", "-p", proj]);
    writeFileSync(join(proj, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `cat > ${dumps}` }] }] } }));
    const prevTrust = process.env.RIGWELL_TRUST_CWD;
    process.env.RIGWELL_TRUST_CWD = "1";
    try {
      const d = driver({ canPrompt: false });
      const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", callingSessionId: "orchestrator-9" });
      await d.turn("hi");
      await d.call("close_session", {});
      expect(JSON.parse(readFileSync(dumps, "utf8"))).toMatchObject({ source: "startup", calling_session_id: "orchestrator-9" });
      const e = driver({ canPrompt: false });
      await e.call("load_session", { sessionId: init.sessionId, cwd: repo });
      await e.call("add_user_message", { text: "again" });
      await e.until(() => e.completed().length > 0);
      expect(JSON.parse(readFileSync(dumps, "utf8"))).toMatchObject({ source: "resume", previous_session_id: init.sessionId, calling_session_id: "orchestrator-9" });
      await e.call("close_session", {});
    } finally { if (prevTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = prevTrust; } // restore: later files in the same bun process inherit it
    void model;
  }, 30_000);
});

describe("tool_result model_content", () => {
  test("capForModel keeps head and tail and says how much was cut", () => {
    expect(capForModel("short", 100)).toBeUndefined();
    const cut = capForModel("A".repeat(500) + "B".repeat(500), 100)!;
    expect(cut.startsWith("A".repeat(60))).toBe(true);
    expect(cut.endsWith("B".repeat(40))).toBe(true);
    expect(cut).toContain("900 characters omitted");
    expect(cut.length).toBeLessThan(250);
  });

  test("the model sees the short version, the user and the transcript keep the full one", async () => {
    const env = tmpEnv();
    try {
      const big = "x".repeat(MODEL_RESULT_CHARS + 5000);
      const bigTool: Tool = { name: "Read", description: "big output", inputSchema: { type: "object", properties: {} }, category: "read", run: async () => ({ content: big }) };
      const stored: any[] = [];
      const shown: any[] = [];
      const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("Read", {}, "big-1") : text("done")), {
        toolsFor: () => [bigTool], notes: shown,
        persistence: { appendMessage: async (m) => { stored.push(m); }, appendTurnOutcome: async () => {}, saveSettings: async () => {} },
      });
      session.addUserMessage("go");
      await session.idle();
      const seen = JSON.stringify(requests[1]!.messages);
      expect(seen).toContain("characters omitted");
      expect(seen.length).toBeLessThan(big.length);
      expect(shown.find((n) => n.type === "tool_result").content.length).toBe(big.length); // the client got the full text
      const result = stored.flatMap((m) => m.content).find((b: any) => b.type === "tool_result");
      expect(result.content.length).toBe(big.length);
      expect(result.modelContent.length).toBeLessThan(big.length);

      // On disk: content stays full, model_content rides next to it; a reload keeps both.
      const f = createSession({ id: "mc-1", cwd: env.root });
      await appendMessage(f, { id: "r1", role: "user", content: [result] }, null);
      const line = readFileSync(f.transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((o) => o.type === "message");
      expect(line.message.content[0].content.length).toBe(big.length);
      expect(line.message.content[0].model_content).toBe(result.modelContent);
      const back = loadTranscript(f).messages[0]!.content[0] as any;
      expect(back.content.length).toBe(big.length);
      expect(back.modelContent).toBe(result.modelContent);
    } finally { env.cleanup(); }
  });
});

describe("notifications", () => {
  test("tool phase streaming_input comes first, then queued and executing", async () => {
    const { repo } = await setup([{ toolCalls: [{ id: "tu-1", name: "Read", input: { path: "greet.js" } }] }, { text: "ok" }]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await d.turn("read it");
    const phases = d.notes("tool_execution_phase_changed").filter((n) => n.toolUseId === "tu-1").map((n) => n.phase);
    expect(phases.slice(0, 3)).toEqual(["streaming_input", "queued", "executing"]);
    expect(phases.at(-1)).toBe("settled_after_execution");
    await d.call("close_session", {});
  }, 30_000);

  test("idle working-state notifications carry backgroundWork", async () => {
    const { repo } = await setup([{ toolCalls: [{ name: "Execute", input: { command: "sleep 30", riskLevel: "low", riskReason: "wait", background: true } }] }, { text: "started" }]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high" });
    await d.turn("start a server");
    const idle = d.notes("agent_working_state_changed").filter((n) => n.newState === "idle");
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.at(-1).backgroundWork).toBe(1);
    await d.call("close_session", {});
    const last = d.notes("agent_working_state_changed").at(-1);
    expect(last).toMatchObject({ newState: "idle", backgroundWork: 0 });
    const plain = (await setup([{ text: "hi" }])).repo;
    const e = driver({ canPrompt: false });
    await e.call("initialize_session", { cwd: plain, modelId: "custom:F-0" });
    await e.turn("hello");
    expect(e.notes("agent_working_state_changed").filter((n) => n.newState === "idle").at(-1).backgroundWork).toBe(0);
    await e.call("close_session", {});
  }, 30_000);
});

describe("Responses profile fields", () => {
  const model = (baseUrl: string): ModelConfig => ({ id: "custom:O-0", model: "gpt-x", displayName: "O", provider: "openai", baseUrl });
  const req = (baseUrl: string, openai: ModelRequest["openai"]): ModelRequest => ({
    model: model(baseUrl), sessionId: "sess-1", system: ["s"], tools: [], messages: [{ id: "u", role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 100, openai,
  });
  const all = { textVerbosity: "low", serviceTier: "flex", safetyIdentifier: true, extendedCache: true };

  test("text.verbosity, service_tier, safety_identifier and prompt_cache_retention come from the profile", () => {
    const b = buildOpenAIBody(req("https://api.openai.com", all));
    expect(b).toMatchObject({ text: { verbosity: "low" }, service_tier: "flex", safety_identifier: "sess-1", prompt_cache_retention: "24h", prompt_cache_key: "sess-1" });
    expect(buildOpenAIBody(req("https://api.openai.com/v1", { safetyIdentifier: "user-42" })).safety_identifier).toBe("user-42");
    const none = buildOpenAIBody(req("https://api.openai.com", undefined));
    for (const k of ["text", "service_tier", "safety_identifier", "prompt_cache_retention"]) expect(k in none).toBe(false);
  });

  test("prompt_cache_retention is sent only against OpenAI's own base URL, never Azure or a custom host", () => {
    expect(isOpenAIBaseUrl("https://api.openai.com/v1")).toBe(true);
    for (const u of ["https://myres.openai.azure.com/openai/v1", "http://127.0.0.1:4010", "https://api.openai.com.evil.test", "not a url"]) {
      expect(isOpenAIBaseUrl(u)).toBe(false);
      const b = buildOpenAIBody(req(u, all));
      expect("prompt_cache_retention" in b).toBe(false);
      expect(b.service_tier).toBe("flex"); // the other fields still go
    }
    // extraArgs still win over everything.
    const m = { ...req("https://api.openai.com", all), model: { ...model("https://api.openai.com"), extraArgs: { service_tier: "priority" } } };
    expect(buildOpenAIBody(m).service_tier).toBe("priority");
  });

  test("profile overlay: settings modelProfiles and the model's own profile feed the fields; bad values are ignored", () => {
    const m: ModelConfig = { ...model("https://api.openai.com"), profile: { serviceTier: "priority", textVerbosity: "loud" } };
    const p = resolveProfile(m, { modelProfiles: { "*": { textVerbosity: "high", extendedCache: true, safetyIdentifier: true } as any } });
    expect(p).toMatchObject({ textVerbosity: "high", serviceTier: "priority", safetyIdentifier: true, extendedCache: true });
    expect(resolveProfile(model("https://api.openai.com")).textVerbosity).toBeUndefined();
  });

  test("a session sends the profile's fields in the request it builds", async () => {
    const { session, requests } = makeStubSession(() => text("ok"), {
      profileSettings: { modelProfiles: { "*": { textVerbosity: "low", serviceTier: "flex" } as any } },
    });
    session.addUserMessage("hi");
    await session.idle();
    expect(requests[0]!.openai).toEqual({ textVerbosity: "low", serviceTier: "flex" });
  });
});

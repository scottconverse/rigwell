// Model profiles, settings keys, trustedFolders enforcement, CLI flags.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenAIMade, resolveProfile } from "../../src/agent/profiles.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { driver } from "./helpers.ts";
import { call, makeStubSession, text, MODEL } from "../agent/helpers.ts";

const servers: FakeServer[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); });
const bodyOf = (srv: FakeServer) => JSON.stringify(srv.requests[0]);

async function setup(extra: Record<string, unknown> = {}, models: any[] = [{ provider: "anthropic", displayName: "F" }]) {
  const model = await startFakeAnthropic([{ text: "ok" }, { text: "ok" }]);
  servers.push(model);
  const home = makeHome(models.map((m) => ({ ...m, url: model.url })));
  const sf = join(home, "settings.json");
  writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), ...extra }));
  process.env.RIGWELL_HOME = home;
  return { model, home, repo: makeRepo() };
}

describe("model profiles", () => {
  test("conservative default; OpenAI-made models default to apply-patch; overlays apply in order", () => {
    const a = resolveProfile({ ...MODEL, model: "claude-x" });
    expect(a).toMatchObject({ toolExecutionMode: "direct_only", promptVariant: "", readLineNumbers: "on_request", fileEditToolProfile: "create-edit", cache: { strategy: "anthropic-breakpoints" } });
    const gpt = { ...MODEL, provider: "openai" as const, model: "gpt-5-mini" };
    expect(isOpenAIMade(gpt)).toBe(true);
    expect(resolveProfile(gpt).fileEditToolProfile).toBe("apply-patch");
    expect(resolveProfile(gpt).cache.strategy).toBe("openai-auto");
    expect(resolveProfile({ ...gpt, model: "llama-3" }).fileEditToolProfile).toBe("create-edit");
    expect(resolveProfile(gpt, { fileEditToolProfile: "create-edit" }).fileEditToolProfile).toBe("create-edit");
    const p = resolveProfile({ ...MODEL, model: "stub", fileEditToolProfile: "apply-patch", profile: { readLineNumbers: "always" } }, {
      modelProfiles: { "*": { promptVariant: "ALL" }, stub: { promptVariant: "STUB", toolDescriptionOverrides: { Read: "r" }, toolExecutionMode: "script_only" } },
    });
    expect(p).toMatchObject({ promptVariant: "STUB", readLineNumbers: "always", fileEditToolProfile: "apply-patch", toolExecutionMode: "script_only", toolDescriptionOverrides: { Read: "r" } });
  });

  test("a profile changes what the model is sent: overlay after the base prompt, descriptions, no cache markers, ApplyPatch, numbered reads", async () => {
    const { model, repo } = await setup({
      modelProfiles: { "custom:F-0": { promptVariant: "PROFILE-OVERLAY-TEXT", toolDescriptionOverrides: { Read: "READ-DESC-OVERRIDE" }, cache: { strategy: "none" }, fileEditToolProfile: "apply-patch", readLineNumbers: "always" } },
    });
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high" });
    await d.turn("hi");
    const req = model.requests[0];
    const sys = req.system.map((s: any) => s.text);
    expect(sys.at(-1)).toBe("PROFILE-OVERLAY-TEXT");
    expect(req.tools.find((t: any) => t.name === "Read").description).toBe("READ-DESC-OVERRIDE");
    expect(req.tools.map((t: any) => t.name)).toContain("ApplyPatch");
    expect(req.tools.map((t: any) => t.name)).not.toContain("Edit");
    expect(JSON.stringify(req)).not.toContain("cache_control");
    await d.call("close_session", {});
  }, 30000);

  test("profile toolExecutionMode script_only; settings compactionTokenLimitPerModel and subagentModelSettings", async () => {
    const s = makeStubSession(() => text("x"), { profileSettings: { modelProfiles: { stub: { toolExecutionMode: "script_only" } } }, compactionTokenLimitPerModel: { "custom:Stub-0": 12345 }, compactionTokenLimit: 99999 });
    expect(s.session.effectiveMode()).toBe("script_only");
    expect(s.session.compactionThreshold()).toBe(12345);

    const kids: string[] = [];
    const t = makeStubSession((req, n) => (n === 0 ? call("Task", { description: "d", prompt: "p", subagent_type: "general" }, "k1") : text("end")), {
      subagentModelSettings: { model: "custom:Stub-0", reasoningEffort: "low" },
      subagents: { limits: new (await import("../../src/subagents/task.ts")).TaskLimits({}), agents: [], depth: 0, rootSessionId: "r", openChild: (o: any) => { kids.push(o.title); return { persistence: { appendMessage: async () => {}, appendTurnOutcome: async () => {}, saveSettings: async () => {} }, transcriptPath: "" }; } },
    });
    t.session.addUserMessage("delegate");
    await t.session.settled();
    expect(kids.length).toBe(1);
  }, 30000);
});

describe("trustedFolders", () => {
  const saved = process.env.RIGWELL_TRUST_CWD;
  beforeEach(() => { delete process.env.RIGWELL_TRUST_CWD; });
  afterEach(() => { process.env.RIGWELL_TRUST_CWD = saved; });

  function project(repo: string) {
    mkdirSync(join(repo, ".rigwell"), { recursive: true });
    writeFileSync(join(repo, ".rigwell", "settings.json"), JSON.stringify({ sessionDefaultSettings: { autonomyLevel: "high" } }));
    writeFileSync(join(repo, "AGENTS.md"), "ALWAYS-SAY-PINEAPPLE");
    mkdirSync(join(repo, ".rigwell", "skills", "projskill"), { recursive: true });
    writeFileSync(join(repo, ".rigwell", "skills", "projskill", "SKILL.md"), "---\nname: projskill\ndescription: a project skill\n---\nbody");
  }

  test("an untrusted folder loads no project settings, AGENTS.md or skills; headless never prompts", async () => {
    const { model, repo } = await setup();
    project(repo);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    expect(init.trusted).toBe(false);
    expect(init.settings.autonomyLevel).toBe("off");
    await d.turn("hi");
    expect(bodyOf(model)).not.toContain("PINEAPPLE");
    expect(bodyOf(model)).not.toContain("projskill");
    await d.call("close_session", {});
    expect(loadSettings({ cwd: repo, trusted: false }).settings.sessionDefaultSettings?.autonomyLevel).toBe("off");
    expect(loadSettings({ cwd: repo }).settings.sessionDefaultSettings?.autonomyLevel).toBe("high");
  }, 30000);

  test("RIGWELL_TRUST_CWD, the trustedFolders setting, and a trust prompt for interactive clients", async () => {
    const a = await setup();
    project(a.repo);
    process.env.RIGWELL_TRUST_CWD = "1";
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: a.repo, modelId: "custom:F-0" });
    expect(init.trusted).toBe(true);
    expect(init.settings.autonomyLevel).toBe("high");
    await d.turn("hi");
    expect(bodyOf(a.model)).toContain("PINEAPPLE");
    await d.call("close_session", {});
    delete process.env.RIGWELL_TRUST_CWD;

    // listed in the user's trustedFolders (a parent folder counts)
    const b = await setup({ trustedFolders: {} });
    project(b.repo);
    writeFileSync(join(b.home, "settings.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(b.home, "settings.json"), "utf8")), trustedFolders: { [b.repo]: { trustedAt: 1 } } }));
    const e = driver({ canPrompt: false });
    expect((await e.call("initialize_session", { cwd: join(b.repo), modelId: "custom:F-0" })).trusted).toBe(true);
    await e.call("close_session", {});

    // an interactive client is asked, and the answer is remembered
    const c = await setup();
    project(c.repo);
    const f = driver({ canPrompt: true, answer: (m) => (m === "request_trust" ? { trust: true } : {}) });
    expect((await f.call("initialize_session", { cwd: c.repo, modelId: "custom:F-0" })).trusted).toBe(true);
    expect(f.requests.find((r) => r.method === "request_trust")!.params.cwd).toBe(c.repo);
    expect(Object.keys(JSON.parse(readFileSync(join(c.home, "settings.json"), "utf8")).trustedFolders)).toEqual([c.repo]);
    await f.call("close_session", {});
    const g = driver({ canPrompt: true, answer: (m) => (m === "request_trust" ? { trust: false } : {}) });
    const d2 = await setup();
    project(d2.repo);
    expect((await g.call("initialize_session", { cwd: d2.repo, modelId: "custom:F-0" })).trusted).toBe(false);
    await g.call("close_session", {});
  }, 30000);
});

describe("CLI flags", () => {
  async function run(args: string[], home: string, cwd: string) {
    const p = Bun.spawn(["bun", CLI, ...args], { cwd, env: { ...process.env, RIGWELL_HOME: home, RIGWELL_TRUST_CWD: "1", RIGWELL_NO_AUTO_TITLE: "1" }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { out, err, code: await p.exited };
  }

  test("-r without an id prints a numbered list; -r <id> and --fork continue a session; spec flags apply", async () => {
    const { model, home, repo } = await setup({}, [{ provider: "anthropic", displayName: "F" }, { provider: "anthropic", displayName: "Spec" }]);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", title: "Listed session" });
    await d.turn("remember the word KIWI");
    await d.call("close_session", {});

    const list = await run(["exec", "-r"], home, repo);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^\s+1\. Listed session {2}\[[0-9a-f-]{36}\]/m);
    expect(list.out).toContain(init.sessionId);

    const resumed = await run(["exec", "--cwd", repo, "-m", "custom:F-0", "-r", init.sessionId, "again"], home, repo);
    expect(resumed.code).toBe(0);
    expect(JSON.stringify(model.requests.at(-1))).toContain("KIWI");

    const forked = await run(["exec", "--cwd", repo, "-m", "custom:F-0", "--fork", init.sessionId, "and a fork"], home, repo);
    expect(forked.code).toBe(0);
    const newId = /\[fork\] \S+ -> (\S+)/.exec(forked.err)![1]!;
    expect(newId).not.toBe(init.sessionId);
    const e = driver({ canPrompt: false });
    await e.call("load_session", { sessionId: newId, cwd: repo });
    expect(JSON.stringify(e.conn.session!.messages)).toContain("and a fork");
    await e.call("close_session", {});

    const spec = await startFakeAnthropic([{ text: "planned" }]);
    servers.push(spec);
    const sf = join(home, "settings.json");
    const j = JSON.parse(readFileSync(sf, "utf8"));
    j.customModels[1].baseUrl = spec.url;
    writeFileSync(sf, JSON.stringify(j));
    const s = await run(["exec", "--cwd", repo, "-m", "custom:F-0", "--use-spec", "--spec-model", "custom:Spec-1", "--spec-reasoning-effort", "low", "plan it"], home, repo);
    expect(s.code).toBe(0);
    expect(spec.requests.length).toBe(1);
    expect(s.err).toContain("[session]");
  }, 60000);
});

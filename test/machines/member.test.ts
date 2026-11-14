import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import type { MemberLimits } from "../../src/workstreams/member.ts";
import { until } from "../workstreams/helpers.ts";

test("remote member retains admission, autonomy/tool caps, user prompts and usage acknowledgement", async () => {
  const env = tmpEnv(), remoteHome = join(env.root, "remote-state"), id = crypto.randomUUID();
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Execute", input: { command: "echo fixture", riskLevel: "medium", riskReason: "fixture" } }] },
    { toolCalls: [{ name: "SendMessage", input: { to: "lead", message: "Remote progress" } }] },
    { text: "Remote member complete" },
  ]);
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), script = join(env.root, "fake-ssh-member.ts");
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  let releaseUsage!: () => void, usageEntered!: () => void, ended!: () => void;
  const entered = new Promise<void>((r) => { usageEntered = r; }), blocked = new Promise<void>((r) => { releaseUsage = r; }), done = new Promise<void>((r) => { ended = r; });
  let admissions = 0, releases = 0, usages = 0, prompts = 0, messages = 0;
  const member = new MemberSession({
    tools: () => [{ name: "SendMessage", description: "Send task data", category: "other", inputSchema: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"] }, async run(input) { expect(input.message).toBe("Remote progress"); messages++; return { content: "delivered" }; } }],
    notify(n) { if (n.type === "agent_turn_completed") ended(); },
    async request(method) { expect(method).toBe("request_permission"); prompts++; return { selectedOption: "proceed_once" }; },
  }, undefined, "off", {
    maxToolIds: ["Execute", "SendMessage"],
    beforeTurn: async () => { admissions++; return () => { releases++; }; },
    onUsage: async () => { usages++; if (usages === 1) { usageEntered(); await blocked; } },
    allowedModelIds: () => ["custom:Remote-fixture-0"],
  }, { machine: "fixture", sessionId: id, connectMachine: async () => new RpcClient(new SshTransport({ name: "fixture", host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })) });
  try {
    await member.call("initialize_session", { sessionId: id, cwd: env.root, modelId: "custom:Remote-fixture-0", autonomyLevel: "high" });
    expect(member.view?.settings.autonomyLevel).toBe("off");
    await member.call("update_session_settings", { autonomyLevel: "high", enabledToolIds: ["Read"] });
    expect(member.view?.settings.autonomyLevel).toBe("off");
    const tools = await member.call("list_tools");
    expect(tools.tools.map((t: any) => t.id).sort()).toEqual(["Execute", "SendMessage"]);
    await member.call("add_user_message", { text: "Fixture task" });
    await entered;
    expect(admissions).toBe(1); expect(fake.requests.length).toBe(1); expect(prompts).toBe(0);
    releaseUsage(); await done;
    expect(prompts).toBe(1); expect(messages).toBe(1); expect(usages).toBe(3);
    expect(member.view?.uiMessages().some((m) => JSON.stringify(m).includes("Remote member complete"))).toBe(true);
  } finally { releaseUsage(); await member.close(); fake.stop(); env.cleanup(); }
  expect(releases).toBe(1);
}, 5000);

async function boundaryFixture(limits: MemberLimits, request: (method: string, p: Record<string, unknown>) => Promise<unknown> = async () => ({ selectedOption: "cancel" })) {
  const env = tmpEnv(), home = join(env.root, "remote-home"), id = crypto.randomUUID();
  const fake = await startFakeAnthropic([{ toolCalls: [{ name: "Execute", input: { command: "echo fixture", riskLevel: "medium", riskReason: "fixture" } }] }, { text: "Remote boundary complete" }]);
  writeJson(join(home, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), script = join(env.root, "fake-ssh-boundary.ts");
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(home)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  let finished!: () => void;
  const done = new Promise<void>((r) => { finished = r; });
  const member = new MemberSession({ tools: (t) => t, request, notify(n) { if (n.type === "agent_turn_completed") finished(); } }, undefined, "off", limits, { machine: "fixture", sessionId: id, connectMachine: async () => new RpcClient(new SshTransport({ name: "fixture", host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })) });
  await member.call("initialize_session", { sessionId: id, cwd: env.root, modelId: "custom:Remote-fixture-0" });
  return { member, fake, done, async close() { await member.close(); fake.stop(); env.cleanup(); } };
}

test("a remote cost budget refuses an unpriced model before any provider request", async () => {
  const f = await boundaryFixture({ allowedModelIds: () => [] });
  try { await f.member.call("warmup_cache"); expect(f.fake.requests.length).toBe(0); await f.member.call("add_user_message", { text: "Fixture" }); await f.done; expect(f.fake.requests.length).toBe(0); }
  finally { await f.close(); }
}, 5000);

test("a remote usage budget stops before a further provider request", async () => {
  let usage = 0;
  const f = await boundaryFixture({ onUsage: () => { usage++; throw new Error("Budget reached"); } });
  try { await f.member.call("add_user_message", { text: "Fixture" }); await f.done; expect(usage).toBe(1); expect(f.fake.requests.length).toBe(1); }
  finally { await f.close(); }
}, 5000);

test("closing a queued remote member aborts its admission without a provider request", async () => {
  let entered!: () => void, aborted = false;
  const admission = new Promise<void>((r) => { entered = r; });
  const f = await boundaryFixture({ beforeTurn: (signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("Cancelled")); }, { once: true }); entered(); }) });
  try { await f.member.call("add_user_message", { text: "Fixture" }); await admission; await f.member.close(); expect(aborted).toBe(true); expect(f.fake.requests.length).toBe(0); }
  finally { await f.close(); }
}, 5000);

test("a pending remote member prompt remains visible and can be answered through its owner", async () => {
  const f = await boundaryFixture({}, async () => new Promise(() => {}));
  try {
    await f.member.call("add_user_message", { text: "Fixture" });
    await until(() => !!f.member.view?.pendingPrompts().length);
    const prompt = f.member.view!.pendingPrompts()[0]!;
    expect(prompt.kind).toBe("permission");
    await f.member.call("answer_request", { requestId: prompt.requestId, answer: { selectedOption: "proceed_once" } });
    await f.done;
    expect(f.member.view!.pendingPrompts().length).toBe(0); expect(f.fake.requests.length).toBe(2);
  } finally { await f.close(); }
}, 5000);

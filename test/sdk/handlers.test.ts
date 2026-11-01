// Gap wave: client handlers in the SDK against the real harness: onTrust, onAskUser, and re-shown pending prompts.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { connectToDaemon, createSession, type Notification } from "../../src/sdk/index.ts";

const MODEL = "custom:Fake-Anthropic-0";
const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

async function setup(script: FakeTurn[]) {
  const server = await startFakeAnthropic(script);
  servers.push(server);
  const repo = makeRepo();
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  return { server, repo, home };
}

const ask = (): FakeTurn[] => [
  { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] },
  { text: "ok" },
];
const write = (): FakeTurn[] => [
  { toolCalls: [{ name: "Execute", input: { command: "echo hi > late.txt", riskLevel: "medium", riskReason: "writes a file" } }] },
  { text: "finished" },
];

const trustedFolders = (home: string) => Object.keys(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders ?? {});

test("onTrust: true trusts and remembers the folder; the default is untrusted", async () => {
  const a = await setup([{ text: "x" }]);
  writeFileSync(join(a.repo, "AGENTS.md"), "be nice\n");
  const env = { RIGWELL_HOME: a.home, RIGWELL_TRUST_CWD: "0" };
  const asked: { cwd: string; unlocks: string[] }[] = [];
  const s1 = await createSession({ cwd: a.repo, env, modelId: MODEL, onTrust: (r) => { asked.push(r); return true; } });
  expect(asked.length).toBe(1);
  expect(asked[0]!.cwd).toBe(a.repo);
  expect(asked[0]!.unlocks.length).toBeGreaterThan(0);
  expect(trustedFolders(a.home).length).toBe(1);
  await s1.close();

  const b = await setup([{ text: "x" }]);
  writeFileSync(join(b.repo, "AGENTS.md"), "be nice\n");
  const s2 = await createSession({ cwd: b.repo, env: { RIGWELL_HOME: b.home, RIGWELL_TRUST_CWD: "0" }, modelId: MODEL });
  expect(trustedFolders(b.home)).toEqual([]);
  await s2.close();

  const c = await setup([{ text: "x" }]);
  writeFileSync(join(c.repo, "AGENTS.md"), "be nice\n");
  const s3 = await createSession({ cwd: c.repo, env: { RIGWELL_HOME: c.home, RIGWELL_TRUST_CWD: "0" }, modelId: MODEL, onTrust: () => { throw new Error("boom"); } });
  expect(trustedFolders(c.home)).toEqual([]);
  await s3.close();

  const d = await setup([{ text: "x" }]);
  writeFileSync(join(d.repo, "AGENTS.md"), "be nice\n");
  const s4 = await createSession({ cwd: d.repo, env: { RIGWELL_HOME: d.home, RIGWELL_TRUST_CWD: "0" }, modelId: MODEL, onTrust: () => ({ trust: true, remember: false }) });
  expect(trustedFolders(d.home)).toEqual([]);
  await s4.close();
}, 60000);

test("onAskUser answers reach the model", async () => {
  const { server, repo, home } = await setup(ask());
  const seen: any[] = [];
  const s = await createSession({
    cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL,
    onAskUser: (req) => { seen.push(req); return { answers: [{ index: 1, question: req.questions[0]!.question, answer: "py" }] }; },
  });
  const r = await s.send("pick one").done;
  expect(r.reason).toBe("completed");
  expect(seen.length).toBe(1);
  expect(typeof seen[0].requestId).toBe("string");
  expect(seen[0].questions[0]).toMatchObject({ index: 1, topic: "Lang", options: ["ts", "py"] });
  expect(JSON.stringify(server.requests[1].messages.at(-1))).toContain("py");
  await s.close();
}, 30000);

test("with no onAskUser the question is cancelled", async () => {
  const { server, repo, home } = await setup(ask());
  const s = await createSession({ cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL });
  expect((await s.send("pick one").done).reason).toBe("completed");
  expect(JSON.stringify(server.requests[1].messages.at(-1))).toMatch(/cancel|assume/i);
  await s.close();
}, 30000);

// ---- re-shown prompts after a reconnect ----
let prevHome: string | undefined;
let prevTrust: string | undefined;
beforeEach(() => { prevHome = process.env.RIGWELL_HOME; prevTrust = process.env.RIGWELL_TRUST_CWD; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
  if (prevTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = prevTrust;
});

async function daemon(script: FakeTurn[]) {
  const ctx = await setup(script);
  process.env.RIGWELL_HOME = ctx.home;
  const sockDir = mkdtempSync(join(tmpdir(), "rigwell-sdk-sock-"));
  const d = await startDaemon({ socketPath: join(sockDir, "d.sock"), automations: false, ws: false });
  return { ...ctx, d };
}
const waitFor = async (pred: () => any, ms = 20000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(5); } };

test("a resumed session re-shows an open permission prompt and answers through answer_request", async () => {
  const { repo, d } = await daemon(write());
  try {
    const first = await connectToDaemon({ socketPath: d.socketPath, cwd: repo, modelId: MODEL, autonomyLevel: "low", onPermission: () => new Promise(() => {}) });
    void first.send("write it");
    await waitFor(() => existsSync(d.socketPath)); // connected
    await Bun.sleep(300);
    await (first as any).client.close(); // the client goes away with the prompt open

    const shown: any[] = [];
    const done: Notification[] = [];
    const second = await connectToDaemon({
      socketPath: d.socketPath, cwd: repo, resumeSessionId: first.sessionId,
      onPermission: (req) => { shown.push(req); return { selectedOption: "proceed_once" }; },
      onNotification: (n) => { if (n.type === "agent_turn_completed") done.push(n); },
    });
    await waitFor(() => done.length > 0);
    expect(shown.length).toBe(1);
    expect(shown[0].toolUses[0].toolUse.name).toBe("Execute");
    expect(existsSync(join(repo, "late.txt"))).toBe(true);
    await second.close();
  } finally {
    d.stop();
  }
}, 60000);

test("a resumed session re-shows an open question; the answer reaches the model", async () => {
  const { repo, server, d } = await daemon(ask());
  try {
    const first = await connectToDaemon({ socketPath: d.socketPath, cwd: repo, modelId: MODEL, onAskUser: () => new Promise(() => {}) });
    void first.send("pick one");
    await Bun.sleep(300);
    await (first as any).client.close();

    const shown: any[] = [];
    const done: Notification[] = [];
    const second = await connectToDaemon({
      socketPath: d.socketPath, cwd: repo, resumeSessionId: first.sessionId,
      onAskUser: (req) => { shown.push(req); return { answers: [{ index: 1, question: req.questions[0]!.question, answer: "py" }] }; },
      onNotification: (n) => { if (n.type === "agent_turn_completed") done.push(n); },
    });
    await waitFor(() => done.length > 0);
    expect(shown.length).toBe(1);
    expect(JSON.stringify(server.requests[1].messages.at(-1))).toContain("py");
    await second.close();
  } finally {
    d.stop();
  }
}, 60000);

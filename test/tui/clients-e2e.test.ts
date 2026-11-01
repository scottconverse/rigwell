// Gap wave: the TUI against the real harness (in-process connection) and the fake model server:
// trust panel, AskUser panel, and prompts re-shown after load_session.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { driver } from "../gap/helpers.ts";
import { runTui } from "../../src/tui/app.ts";
import { inProcessTransport } from "../../src/sdk/in-process.ts";

const servers: FakeServer[] = [];
let prevTrust: string | undefined;
beforeEach(() => { prevTrust = process.env.RIGWELL_TRUST_CWD; });
afterEach(() => {
  servers.splice(0).forEach((s) => s.stop());
  if (prevTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = prevTrust;
});

async function setup(script: FakeTurn[]) {
  const model = await startFakeAnthropic(script);
  servers.push(model);
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
  process.env.RIGWELL_HOME = home;
  return { model, home, repo: makeRepo() };
}

function start(repo: string, extra: Record<string, unknown> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (c) => { out += c; });
  const done = runTui({
    cwd: repo, makeTransport: async () => inProcessTransport(), sessionParams: { modelId: "custom:F-0" },
    stdin: stdin as any, stdout: stdout as any, ...extra,
  });
  return { stdin, done, out: () => out };
}
const until = async (pred: () => any, ms = 20000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(5); } };
const trusted = (home: string) => Object.keys(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders ?? {});

test("trust panel: yes trusts and remembers the folder, even though the question arrives before the session exists", async () => {
  process.env.RIGWELL_TRUST_CWD = "0";
  const { model, home, repo } = await setup([{ text: "hello" }]);
  writeFileSync(join(repo, "AGENTS.md"), "be brief\n");
  const t = start(repo);
  await Bun.sleep(300);
  t.stdin.write("1"); // "Yes, trust this folder"
  await until(() => trusted(home).length === 1);
  t.stdin.write("hi\r");
  await until(() => model.requests.length === 1);
  // the trusted folder's instruction file reached the model
  expect(JSON.stringify(model.requests[0])).toContain("be brief");
  t.stdin.end();
  expect(await t.done).toBe(0);
}, 40000);

test("trust panel: Enter on the default does not trust; the AGENTS.md stays out", async () => {
  process.env.RIGWELL_TRUST_CWD = "0";
  const { model, home, repo } = await setup([{ text: "hello" }]);
  writeFileSync(join(repo, "AGENTS.md"), "be brief\n");
  const t = start(repo);
  await Bun.sleep(300);
  t.stdin.write("\r");
  await Bun.sleep(200);
  t.stdin.write("hi\r");
  await until(() => model.requests.length === 1);
  expect(JSON.stringify(model.requests[0])).not.toContain("be brief");
  expect(trusted(home)).toEqual([]);
  t.stdin.end();
  expect(await t.done).toBe(0);
}, 40000);

test("AskUser panel: the chosen option reaches the model", async () => {
  const { model, repo } = await setup([
    { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] },
    { text: "ok" },
  ]);
  const t = start(repo);
  await Bun.sleep(300);
  t.stdin.write("pick one\r");
  await until(() => model.requests.length === 1);
  await Bun.sleep(300); // the panel is up once the model has answered
  t.stdin.write("2");
  await until(() => model.requests.length === 2);
  expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain("py");
  t.stdin.end();
  expect(await t.done).toBe(0);
}, 40000);

test("a prompt left open when another client went away is re-shown by load_session and answered with answer_request", async () => {
  const { model, repo } = await setup([
    { toolCalls: [{ name: "Execute", input: { command: "echo hi > late.txt", riskLevel: "medium", riskReason: "writes a file" } }] },
    { text: "finished" },
  ]);
  const a = driver({ canPrompt: true, answer: () => new Promise(() => {}) });
  const init = await a.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low" });
  await a.call("add_user_message", { text: "make it" });
  await a.until(() => a.requests.some((r) => r.method === "request_permission"));
  await a.conn.shutdown({ park: true });

  const t = start(repo, { resumeSessionId: init.sessionId });
  await Bun.sleep(400);
  t.stdin.write("\r"); // the permission panel is on screen again: allow once
  await until(() => existsSync(join(repo, "late.txt")));
  await until(() => model.requests.length === 2);
  t.stdin.end();
  expect(await t.done).toBe(0);
  expect(t.out()).toContain("finished");
}, 40000);

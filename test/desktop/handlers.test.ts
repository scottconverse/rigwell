// Gap wave: the desktop session controller against a real daemon and the fake model server (renderer code run in
// bun with a stand-in for the preload bridge): trust asks, the AskUser prompt, and prompts re-shown after a reload.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { SocketTransport, type Transport } from "../../src/sdk/transport.ts";
import { SessionController, trustAsks } from "../../desktop/renderer/lib/session.ts";
import { MODEL, sleep, startTestDaemon } from "./helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => { servers.forEach((s) => s.stop()); delete (globalThis as any).window; });

/** What the preload script gives the renderer, with the daemon reached over its Unix socket. The renderer wires its
 *  listeners once per process, so one bridge object serves every test and only the socket path changes. */
const target = { socketPath: "" };
const conns = new Map<number, Transport>();
const listeners: ((e: { connId: number; message: string }) => void)[] = [];
const closed: ((e: { connId: number }) => void)[] = [];
let connN = 0;
const fakeWindow = {
  rigwell: {
    daemon: {
      open: async () => {
        const id = ++connN;
        const t = await SocketTransport.connect(target.socketPath);
        t.onMessage = (message) => listeners.forEach((l) => l({ connId: id, message }));
        t.onClose = () => closed.forEach((l) => l({ connId: id }));
        conns.set(id, t);
        return id;
      },
      sendMessage: async (id: number, message: string) => { conns.get(id)?.write(message); },
      close: async (id: number) => { await conns.get(id)?.close(); },
      onMessage: (cb: any) => { listeners.push(cb); return () => {}; },
      onClosed: (cb: any) => { closed.push(cb); return () => {}; },
    },
    view: { set: async () => {} },
    browser: { cdpUrl: async () => null },
  },
};
const installBridge = (socketPath: string) => { target.socketPath = socketPath; (globalThis as any).window = fakeWindow; };

const until = async (pred: () => any, ms = 20000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(5); } };

let prevTrust: string | undefined;
beforeEach(() => { prevTrust = process.env.RIGWELL_TRUST_CWD; });
afterEach(() => { if (prevTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = prevTrust; });

async function setup(script: FakeTurn[]) {
  const model = await startFakeAnthropic(script);
  servers.push(model);
  const { d, home } = await startTestDaemon(model.url);
  installBridge(d.socketPath);
  return { model, d, home, repo: makeRepo() };
}

describe("desktop: trust", () => {
  test("request_trust becomes a trust ask outside any session view; yes is remembered, no is not", async () => {
    process.env.RIGWELL_TRUST_CWD = "0";
    const a = await setup([{ text: "x" }]);
    writeFileSync(join(a.repo, "AGENTS.md"), "be brief\n");
    const unsub = trustAsks.subscribe(() => {
      const ask = trustAsks.getSnapshot().asks[0];
      if (ask) { expect(ask.cwd).toBe(a.repo); expect(ask.unlocks.length).toBeGreaterThan(0); trustAsks.answer(ask.id, true); }
    });
    const ctl = await SessionController.create({ cwd: a.repo, modelId: MODEL });
    unsub();
    expect(ctl.getSnapshot().phase).toBe("ready");
    expect(Object.keys(JSON.parse(readFileSync(join(a.home, "settings.json"), "utf8")).trustedFolders ?? {})).toEqual([a.repo]);
    ctl.close();
    a.d.stop();

    const b = await setup([{ text: "x" }]);
    writeFileSync(join(b.repo, "AGENTS.md"), "be brief\n");
    const unsub2 = trustAsks.subscribe(() => {
      const ask = trustAsks.getSnapshot().asks[0];
      if (ask) trustAsks.answer(ask.id, false);
    });
    const ctl2 = await SessionController.create({ cwd: b.repo, modelId: MODEL });
    unsub2();
    expect(JSON.parse(readFileSync(join(b.home, "settings.json"), "utf8")).trustedFolders).toBeUndefined();
    ctl2.close();
    b.d.stop();
  }, 40000);
});

describe("desktop: AskUser and re-shown prompts", () => {
  const ask = (): FakeTurn[] => [
    { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] },
    { text: "ok" },
  ];
  const write = (): FakeTurn[] => [
    { toolCalls: [{ name: "Execute", input: { command: "echo hi > late.txt", riskLevel: "medium", riskReason: "writes a file" } }] },
    { text: "finished" },
  ];

  test("an ask_user prompt carries the harness fields; answering reaches the model", async () => {
    const { model, d, repo } = await setup(ask());
    const ctl = await SessionController.create({ cwd: repo, modelId: MODEL });
    void ctl.send("pick one");
    await until(() => ctl.getSnapshot().prompts.length === 1);
    const p = ctl.getSnapshot().prompts[0]!;
    expect(p.method).toBe("ask_user");
    expect(p.params.questions[0]).toMatchObject({ index: 1, topic: "Lang", options: ["ts", "py"] });
    ctl.answer(p.requestId, { answers: [{ index: 1, question: "Which language?", answer: "py" }] });
    await until(() => model.requests.length === 2);
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain("py");
    await until(() => ctl.getSnapshot().working === "idle");
    ctl.close();
    d.stop();
  }, 40000);

  test("a reloaded view re-shows the open permission prompt and answers it with answer_request", async () => {
    const { d, repo } = await setup(write());
    const first = await SessionController.create({ cwd: repo, modelId: MODEL, autonomyLevel: "low" });
    const id = first.getSnapshot().sessionId!;
    void first.send("make it");
    await until(() => first.getSnapshot().prompts.length === 1);
    first.conn!.close(); // the window reloads: the connection drops with the prompt open
    await sleep(100);

    const again = await SessionController.resume(id, repo);
    const prompts = again.getSnapshot().prompts;
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ method: "request_permission", reshown: true });
    expect(prompts[0]!.params.toolUses[0].toolUse.name).toBe("Execute");
    again.answer(prompts[0]!.requestId, { selectedOption: "proceed_once" });
    await until(() => existsSync(join(repo, "late.txt")));
    await until(() => again.getSnapshot().items.some((i: any) => i.kind === "assistant" && /finished/.test(i.text)));
    expect(again.getSnapshot().prompts).toEqual([]);
    again.close();
    d.stop();
  }, 40000);

  test("closing a view that shows a re-shown prompt leaves it open for the next load_session", async () => {
    const { d, repo } = await setup(write());
    const first = await SessionController.create({ cwd: repo, modelId: MODEL, autonomyLevel: "low" });
    const id = first.getSnapshot().sessionId!;
    void first.send("make it");
    await until(() => first.getSnapshot().prompts.length === 1);
    first.conn!.close();
    await sleep(100);
    const second = await SessionController.resume(id, repo);
    expect(second.getSnapshot().prompts.length).toBe(1);
    second.close(); // not answered, not cancelled
    await sleep(200);
    const third = await SessionController.resume(id, repo);
    expect(third.getSnapshot().prompts.length).toBe(1);
    third.answer(third.getSnapshot().prompts[0]!.requestId, { selectedOption: "cancel" });
    await until(() => third.getSnapshot().working === "idle");
    third.close();
    d.stop();
  }, 40000);
});

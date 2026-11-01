// Protocol-level end-to-end tests: permissions, interrupt, resume, daemon, error codes (Anthropic fake unless noted).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, RpcChild, fixBugScript, lastToolResult, makeHome, makeRepo } from "./helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const MODEL = "custom:Fake-Anthropic-0";
const exec = (cmd: string, risk?: string): FakeTurn => () => ({
  toolCalls: [{ name: "Execute", input: { command: cmd, ...(risk ? { riskLevel: risk, riskReason: "test" } : {}) } }],
});

async function setup(script: FakeTurn[]) {
  const server = await startFakeAnthropic(script);
  servers.push(server);
  const repo = makeRepo();
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  return { server, repo, home };
}

async function start(args: string[], ctx: { repo: string; home: string }, initExtra: Record<string, unknown> = {}) {
  const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", ...args], { cwd: ctx.repo, env: { RIGWELL_HOME: ctx.home } });
  const init = await c.call("initialize_session", { machineId: "default", cwd: ctx.repo, modelId: MODEL, ...initExtra });
  return { c, init };
}

const permReqs = (c: RpcChild) => c.messages.filter((m) => m.type === "request" && m.method === "rigwell.request_permission");

describe("permission flow", () => {
  test("medium Execute at --auto low: proceed_once runs it", async () => {
    const ctx = await setup([exec("echo hi > out.txt", "medium"), { text: "done" }]);
    const { c } = await start(["--auto", "low"], ctx);
    c.onRequest = () => ({ selectedOption: "proceed_once" });
    await c.call("add_user_message", { text: "write it", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("completed");
    const reqs = permReqs(c);
    expect(reqs.length).toBe(1);
    expect(reqs[0].params.toolUses[0].confirmationType).toBe("exec");
    expect(reqs[0].params.options.map((o: any) => o.value)).toEqual(["proceed_once", "proceed_always", "cancel"]);
    expect(existsSync(join(ctx.repo, "out.txt"))).toBe(true);
    expect(c.notifications().some((n) => n.type === "permission_resolved" && n.selectedOption === "proceed_once")).toBe(true);
  }, 30000);

  test("proceed_always raises autonomy to medium; second medium call needs no request", async () => {
    const ctx = await setup([exec("echo a > a.txt", "medium"), exec("echo b > b.txt", "medium"), { text: "done" }]);
    const { c } = await start(["--auto", "low"], ctx);
    c.onRequest = () => ({ selectedOption: "proceed_always" });
    await c.call("add_user_message", { text: "go", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("completed");
    expect(permReqs(c).length).toBe(1);
    expect(c.notifications().some((n) => n.type === "settings_updated" && n.settings.autonomyLevel === "medium")).toBe(true);
    expect(existsSync(join(ctx.repo, "a.txt"))).toBe(true);
    expect(existsSync(join(ctx.repo, "b.txt"))).toBe(true);
  }, 30000);

  test("cancel: command does not run and the turn ends permission_rejected", async () => {
    const ctx = await setup([exec("echo hi > out.txt", "medium"), { text: "unreachable" }]);
    const { c } = await start(["--auto", "low"], ctx);
    c.onRequest = () => ({ selectedOption: "cancel" });
    await c.call("add_user_message", { text: "go", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("permission_rejected");
    expect(existsSync(join(ctx.repo, "out.txt"))).toBe(false);
    expect(ctx.server.requests.length).toBe(1);
  }, 30000);

  test("deny-listed command asks even at --auto high and offers no proceed_always", async () => {
    // `mkfs --help` matches the filesystem-format safeguard but only prints usage, so it is harmless even if it ran.
    const ctx = await setup([exec("mkfs --help", "low"), { text: "unreachable" }]);
    const { c } = await start(["--auto", "high"], ctx);
    c.onRequest = () => ({ selectedOption: "cancel" });
    await c.call("add_user_message", { text: "go", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    const reqs = permReqs(c);
    expect(reqs.length).toBe(1);
    expect(reqs[0].params.toolUses[0].confirmationType).toBe("exec");
    expect(reqs[0].params.options.map((o: any) => o.value)).toEqual(["proceed_once", "cancel"]);
    expect(done.params.notification.reason).toBe("permission_rejected");
    expect(c.notifications().some((n) => n.type === "tool_result" && n.isError)).toBe(true);
  }, 30000);

  test("autoRejectPermissionRequests: rejection goes to the model and the turn completes", async () => {
    const ctx = await setup([
      exec("echo hi > out.txt", "medium"),
      (body) => {
        if (!/rejected/i.test(lastToolResult(body))) throw new Error("rejection not sent to model: " + lastToolResult(body));
        return { text: "ok, not running it" };
      },
    ]);
    const { c } = await start([], ctx, { autoRejectPermissionRequests: true });
    await c.call("add_user_message", { text: "go", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("completed");
    expect(permReqs(c).length).toBe(0);
    expect(existsSync(join(ctx.repo, "out.txt"))).toBe(false);
    expect(ctx.server.requests.length).toBe(2);
    expect(c.stderr).not.toContain("script exhausted");
  }, 30000);

  test("Execute without riskLevel is refused and nothing runs", async () => {
    const ctx = await setup([
      exec("echo hi > out.txt"),
      (body) => {
        if (!/riskLevel/.test(lastToolResult(body))) throw new Error("missing-risk message not sent: " + lastToolResult(body));
        return { text: "will resend" };
      },
    ]);
    const { c } = await start(["--auto", "high"], ctx);
    await c.call("add_user_message", { text: "go", messageId: "t1" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("completed");
    expect(existsSync(join(ctx.repo, "out.txt"))).toBe(false);
    expect(ctx.server.requests.length).toBe(2);
    const tr = c.notifications().find((n) => n.type === "tool_result");
    expect(tr.isError).toBe(true);
  }, 30000);
});

describe("exec modes", () => {
  test("prompt mode without an approver exits 1 and tells the user to raise --auto", async () => {
    const ctx = await setup([exec("echo hi > out.txt", "medium"), { text: "unreachable" }]);
    const p = Bun.spawn(["bun", CLI, "exec", "do it"], { cwd: ctx.repo, env: { ...process.env, RIGWELL_HOME: ctx.home }, stdout: "pipe", stderr: "pipe" });
    const [err, code] = [await new Response(p.stderr).text(), await p.exited];
    expect(code).toBe(1);
    expect(err).toContain("higher --auto");
    expect(err).toContain("no_approver_available");
    expect(existsSync(join(ctx.repo, "out.txt"))).toBe(false);
  }, 30000);

  test("read-only exec offers Read, Execute, Grep, Glob plus Script and script_job", async () => {
    const ctx = await setup([{ text: "hello" }]);
    const { c } = await start([], ctx);
    await c.call("add_user_message", { text: "hi", messageId: "t1" });
    await c.turnCompleted();
    await c.close();
    const names = ctx.server.requests[0].tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["AskUser", "Execute", "FetchUrl", "Glob", "Grep", "LS", "Read", "Script", "TaskOutput", "TaskStop", "TodoWrite", "call_tool", "load_tools", "script_job"]);
  }, 30000);

  test("resume: load_session restores messages and the model sees turn 1 in turn 2", async () => {
    const ctx = await setup([{ text: "first answer" }, { text: "second answer" }]);
    const first = await start([], ctx);
    const sessionId = first.init.sessionId;
    await first.c.call("add_user_message", { text: "remember the word PINEAPPLE", messageId: "t1" });
    await first.c.turnCompleted();
    await first.c.call("close_session", { reason: "other" });
    expect(await first.c.close()).toBe(0);

    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], { cwd: ctx.repo, env: { RIGWELL_HOME: ctx.home } });
    const loaded = await c.call("load_session", { sessionId, cwd: ctx.repo });
    expect(loaded.sessionId).toBe(sessionId);
    expect(JSON.stringify(loaded.session.messages)).toContain("PINEAPPLE");
    await c.call("add_user_message", { text: "what was the word?", messageId: "t2" });
    const done = await c.turnCompleted();
    await c.close();
    expect(done.params.notification.reason).toBe("completed");
    const body = JSON.stringify(ctx.server.requests[1]);
    expect(body).toContain("PINEAPPLE");
    expect(body).toContain("first answer");
    expect(body).toContain("what was the word?");
  }, 30000);

  test("interrupt: a running sleep is cancelled quickly, then the session goes idle", async () => {
    const ctx = await setup([exec("sleep 5", "low"), { text: "unreachable" }]);
    const { c } = await start(["--auto", "low"], ctx);
    await c.call("add_user_message", { text: "sleep", messageId: "t1" });
    await c.waitFor((m) => m.params?.notification?.type === "tool_execution_phase_changed" && m.params.notification.phase === "executing");
    const t0 = Date.now();
    await c.call("interrupt_session", {});
    const done = await c.turnCompleted();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(done.params.notification.reason).toBe("cancelled");
    await c.waitFor((m) => m.params?.notification?.type === "agent_working_state_changed" && m.params.notification.newState === "idle");
    await c.close();
  }, 30000);
});

describe("protocol errors", () => {
  test("unknown method, request before initialize, and a non-JSON line", async () => {
    const ctx = await setup([{ text: "ok" }]);
    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], { cwd: ctx.repo, env: { RIGWELL_HOME: ctx.home } });
    const raw = async (id: string, method: string) => {
      c.send({ jsonrpc: "2.0", type: "request", id, method, params: {} });
      return (await c.waitFor((m) => m.type === "response" && m.id === id)).error;
    };
    expect((await raw("e1", "rigwell.add_user_message"))?.code).toBe(-32005);
    expect((await raw("e2", "rigwell.no_such_method"))?.code).toBe(-32601);
    (c.proc.stdin as any).write("this is not json\n");
    const init = await c.call("initialize_session", { machineId: "default", cwd: ctx.repo, modelId: MODEL });
    expect(init.sessionId).toBeTruthy();
    await c.call("add_user_message", { text: "hi", messageId: "t1" });
    expect((await c.turnCompleted()).params.notification.reason).toBe("completed");
    await c.close();
  }, 30000);
});

// Minimal NDJSON JSON-RPC client over a Unix socket.
async function socketClient(path: string) {
  const messages: any[] = [];
  let buf = "";
  let n = 0;
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  const sock = await Bun.connect({
    unix: path,
    socket: {
      data(_s, chunk) {
        buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          messages.push(m);
          for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k].pred(m)) waiters.splice(k, 1)[0].resolve(m);
        }
      },
    },
  });
  const waitFor = (pred: (m: any) => boolean, ms = 20000) => {
    const hit = messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("socket client timeout")), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  return {
    messages, waitFor, sock,
    async call(method: string, params: Record<string, unknown>) {
      const id = `s-${++n}`;
      sock.write(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      const r = await waitFor((m) => m.type === "response" && m.id === id);
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result;
    },
    turnCompleted: () => waitFor((m) => m.params?.notification?.type === "agent_turn_completed"),
    end: () => sock.end(),
  };
}

describe("daemon", () => {
  test("two concurrent sessions, one per provider, both fix their repos", async () => {
    const a = await startFakeAnthropic(fixBugScript());
    const o = await startFakeOpenAI(fixBugScript());
    servers.push(a, o);
    const home = makeHome([
      { provider: "anthropic", url: a.url, displayName: "Fake Anthropic" },
      { provider: "openai", url: o.url, displayName: "Fake OpenAI" },
    ]);
    const repoA = makeRepo();
    const repoO = makeRepo();
    const prevHome = process.env.RIGWELL_HOME;
    process.env.RIGWELL_HOME = home;
    const sockDir = mkdtempSync(join(tmpdir(), "rigwell-e2e-sock-"));
    const daemon = await startDaemon({ socketPath: join(sockDir, "d.sock"), log: () => {} });
    try {
      const [ca, co] = await Promise.all([socketClient(daemon.socketPath), socketClient(daemon.socketPath)]);
      const [ia, io] = await Promise.all([
        ca.call("initialize_session", { machineId: "default", cwd: repoA, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "low" }),
        co.call("initialize_session", { machineId: "default", cwd: repoO, modelId: "custom:Fake-OpenAI-1", autonomyLevel: "low" }),
      ]);
      expect(ia.sessionId).not.toBe(io.sessionId);
      expect(daemon.sessionCount).toBe(2);
      await Promise.all([
        ca.call("add_user_message", { text: "check.js fails. Fix the bug.", messageId: "a1" }),
        co.call("add_user_message", { text: "check.js fails. Fix the bug.", messageId: "o1" }),
      ]);
      const [da, dO] = await Promise.all([ca.turnCompleted(), co.turnCompleted()]);
      expect(da.params.notification.reason).toBe("completed");
      expect(dO.params.notification.reason).toBe("completed");
      expect(daemon.sessionCount).toBe(2);
      for (const r of [repoA, repoO]) expect(execFileSync("node", ["check.js"], { cwd: r, encoding: "utf8" })).toContain("PASS");
      expect(readFileSync(join(repoA, "greet.js"), "utf8")).toContain('"Hello, "');
      expect(a.requests.length).toBe(4);
      expect(o.requests.length).toBe(4);
      ca.end();
      co.end();
    } finally {
      daemon.stop();
      if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    }
  }, 40000);
});

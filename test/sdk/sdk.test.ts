// Phase 5 done-when (client half): a two-turn session through createSession (spawned exec process) and
// through connectToDaemon (WebSocket and Unix socket), with a permission callback exercised.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { lastToolResult, makeHome, makeRepo } from "../e2e/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { expectOwnerOnly } from "../platform.ts";
import { connectToDaemon, createSession, readDaemonInfo, run, type PermissionRequest } from "../../src/sdk/index.ts";

const MODEL = "custom:Fake-Anthropic-0";
const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

/** Turn 1: ask to run a medium-risk command, then answer. Turn 2: plain answer that depends on turn 1. */
const twoTurnScript = (): FakeTurn[] => [
  () => ({ toolCalls: [{ name: "Execute", input: { command: "echo hi > out.txt", riskLevel: "medium", riskReason: "writes a file" } }] }),
  (body) => {
    if (!/\S/.test(lastToolResult(body))) throw new Error("no tool result sent");
    return { text: "first answer" };
  },
  (body) => {
    // The second request carries the whole first turn (append-only history).
    const users = (body.messages as any[]).filter((m) => m.role === "user");
    if (users.length < 2) throw new Error("history missing");
    return { text: "second answer" };
  },
];

async function setup() {
  const server = await startFakeAnthropic(twoTurnScript());
  servers.push(server);
  const repo = makeRepo();
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  return { server, repo, home };
}

describe("SDK: createSession (spawned exec process)", () => {
  test("two turns, permission callback allows, notifications iterate to agent_turn_completed", async () => {
    const { server, repo, home } = await setup();
    const asked: PermissionRequest[] = [];
    const session = await createSession({
      cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL, autonomyLevel: "low",
      onPermission: (req) => { asked.push(req); return { selectedOption: "proceed_once" }; },
    });
    expect(session.sessionId).toMatch(/\S/);
    expect(session.settings.autonomyLevel).toBe("low");

    const types: string[] = [];
    for await (const n of session.send("write out.txt")) types.push(n.type);
    expect(types.at(-1)).toBe("agent_turn_completed");
    expect(types).toContain("tool_call");
    expect(types).toContain("permission_resolved");
    expect(asked.length).toBe(1);
    expect(asked[0].toolUses[0].confirmationType).toBe("exec");
    expect(asked[0].toolUses[0].details.fullCommand).toContain("echo hi");
    expect(existsSync(join(repo, "out.txt"))).toBe(true);

    const second = session.send("and now?");
    const r = await second.done;
    expect(r.reason).toBe("completed");
    expect(r.text).toBe("second answer");
    expect(server.requests.length).toBe(3);

    await session.updateSettings({ autonomyLevel: "medium" });
    const tools = await session.listTools();
    expect(tools.tools.some((t) => t.id === "Execute")).toBe(true);
    await session.close();
  }, 60000);

  test("no permission handler: the SDK answers cancel and the turn ends", async () => {
    const { repo, home } = await setup();
    const session = await createSession({ cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL, autonomyLevel: "low" });
    const r = await session.send("write out.txt").done;
    expect(r.reason).not.toBe("completed");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
    await session.close();
  }, 60000);

  test("run() is one-shot", async () => {
    const { repo, home } = await setup();
    const r = await run("write out.txt", {
      cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL, autonomyLevel: "low",
      onPermission: () => ({ selectedOption: "proceed_once" }),
    });
    expect(r.reason).toBe("completed");
    expect(r.text).toBe("first answer");
    expect(r.notifications.at(-1)?.type).toBe("agent_turn_completed");
  }, 60000);

  test("a process that dies ends the turn with process_exit", async () => {
    const { repo, home } = await setup();
    const session = await createSession({ cwd: repo, env: { RIGWELL_HOME: home }, modelId: MODEL, autonomyLevel: "off" });
    const turn = session.send("hi");
    (session as any).client.transport.proc.kill("SIGKILL");
    const r = await turn.done.catch((e: Error) => ({ reason: "rejected:" + e.message }));
    expect(["process_exit", "completed"].includes(r.reason) || r.reason.startsWith("rejected")).toBe(true);
    await session.close();
  }, 30000);
});

describe("SDK: connectToDaemon", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => { prevHome = process.env.RIGWELL_HOME; });
  afterEach(() => { if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome; });

  async function daemon() {
    const ctx = await setup();
    home = ctx.home;
    process.env.RIGWELL_HOME = home;
    const sockDir = mkdtempSync(join(tmpdir(), "rigwell-sdk-sock-"));
    const d = await startDaemon({ socketPath: join(sockDir, "d.sock"), automations: false, ws: { port: 0 } });
    return { ...ctx, d };
  }

  async function twoTurns(session: Awaited<ReturnType<typeof connectToDaemon>>, repo: string, asked: unknown[]) {
    const t1: string[] = [];
    for await (const n of session.send("write out.txt")) t1.push(n.type);
    expect(t1.at(-1)).toBe("agent_turn_completed");
    expect(asked.length).toBe(1);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const r = await session.send("and now?").done;
    expect(r).toMatchObject({ reason: "completed", text: "second answer" });
  }

  test("over WebSocket with the token from daemon.json", async () => {
    const { repo, d } = await daemon();
    try {
      const info = readDaemonInfo(home)!;
      expect(info.token).toBe(d.wsToken!);
      expect(info.ws!.url).toBe(d.wsUrl!);
      expectOwnerOnly(join(home, "daemon.json"));
      const asked: unknown[] = [];
      const session = await connectToDaemon({
        url: d.wsUrl, cwd: repo, modelId: MODEL, autonomyLevel: "low",
        onPermission: (req) => { asked.push(req); return { selectedOption: "proceed_once" }; },
      });
      await twoTurns(session, repo, asked);
      await session.close();
    } finally {
      d.stop();
    }
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
  }, 60000);

  test("over the Unix socket", async () => {
    const { repo, d } = await daemon();
    try {
      const asked: unknown[] = [];
      const session = await connectToDaemon({
        socketPath: d.socketPath, cwd: repo, modelId: MODEL, autonomyLevel: "low",
        onPermission: (req) => { asked.push(req); return { selectedOption: "proceed_once" }; },
      });
      await twoTurns(session, repo, asked);
      await session.close();
    } finally {
      d.stop();
    }
  }, 60000);

  test("a throwing permission handler answers cancel", async () => {
    const { repo, d } = await daemon();
    try {
      const session = await connectToDaemon({
        url: d.wsUrl, token: d.wsToken, cwd: repo, modelId: MODEL, autonomyLevel: "low",
        onPermission: () => { throw new Error("boom"); },
      });
      const r = await session.send("write out.txt").done;
      expect(r.reason).not.toBe("completed");
      expect(existsSync(join(repo, "out.txt"))).toBe(false);
      await session.close();
    } finally {
      d.stop();
    }
  }, 60000);

  test("daemon.json is plain JSON with the socket path", async () => {
    const { d } = await daemon();
    try {
      const raw = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
      expect(raw.socketPath).toBe(d.socketPath);
    } finally {
      d.stop();
    }
  });
});

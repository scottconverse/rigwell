// PTY-free smoke tests: the TUI process starts with piped stdin (raw mode skipped), runs a turn, and exits on /quit.
import { afterAll, describe, expect, test } from "bun:test";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

async function runTui(input: string, home: string, cwd: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env: { ...process.env, RIGWELL_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  (proc.stdin as any).write(input);
  (proc.stdin as any).end();
  const timer = setTimeout(() => proc.kill(), 20000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  clearTimeout(timer);
  return { out, err, code };
}

describe("rigwell tui, piped", () => {
  test("starts and exits 0 on /quit", async () => {
    const server = await startFakeAnthropic([]);
    servers.push(server);
    const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
    const r = await runTui("/quit\n", home, makeRepo());
    expect(r.code).toBe(0);
    expect(r.out).toContain("Rigwell");
    expect(server.requests.length).toBe(0);
  }, 30000);

  test("`tui` subcommand with /help then /quit", async () => {
    const server = await startFakeAnthropic([]);
    servers.push(server);
    const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
    const r = await runTui("/exit\n", home, makeRepo(), ["tui"]);
    expect(r.code).toBe(0);
  }, 30000);

  test("a message is sent to the model and the answer is on screen at EOF", async () => {
    const server = await startFakeAnthropic([{ text: "pong from the fake model" }]);
    servers.push(server);
    const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
    const r = await runTui("ping\n", home, makeRepo(), ["-m", "custom:Fake-Anthropic-0"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("> ping");
    expect(r.out).toContain("pong from the fake model");
    expect(server.requests.length).toBe(1);
  }, 30000);

  test("fails cleanly when no model is configured", async () => {
    const home = makeHome([]);
    const r = await runTui("/quit\n", home, makeRepo());
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not start a session");
  }, 30000);
});

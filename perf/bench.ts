#!/usr/bin/env bun
// Benchmarks for the spec section 7 targets. Everything runs locally against the fake model servers in test/fakes.
//
//   bun perf/bench.ts [--out results.json] [--quick] [--only keystroke,prompt]
//
// Method (also in perf/README.md):
//  * First-keystroke latency, in-process (gated): the TUI controller (src/tui/app.ts runTui) runs in this process with a
//    fake TTY stdin/stdout over a real in-process session and a fake model server. After a long answer is on screen
//    (so redraws are not trivially small), each sample is the time from `stdin.emit("data", <one key>)` until the
//    redrawn frame is written to stdout. Many keystrokes, p50/p95 by nearest rank.
//  * First-keystroke latency, pty (reported, and capped at the spec target): the real `rigwell` process runs under a
//    pseudo-terminal (Bun.Terminal); a key is written to the pty master and the sample ends when the next output
//    chunk arrives. Includes the process and kernel pty path.
//  * Turn preparation: add_user_message sent over an in-process connection until the fake model server sees the request.
//  * Pre-flight tool lookup: mean time of toolsForSession (the tool set computed for every request).
//  * exec first request: spawn `rigwell exec "<prompt>"` until the fake server receives the first request.
//  * Daemon ready: spawn `rigwell daemon` until it prints "listening". Per-session memory: RSS delta (from /proc) after
//    opening N sessions over the socket, divided by N.
//  * Quit: "/quit" typed into the pty until the process exits. First paint / first prompt accepted: pty, from spawn.
//  * Base prompt: sizes of the first request (Phase 3 budget helper requestSizes) for both execution modes.
import { readFileSync, writeFileSync } from "node:fs";

// The benchmarks measure the harness, not session titling or trust prompts: the fake servers serve a fixed
// script, and a title side request would consume a scripted turn (same settings as test/preload.ts).
process.env.RIGWELL_NO_AUTO_TITLE ??= "1";
process.env.RIGWELL_TRUST_CWD ??= "1";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { startFakeAnthropic } from "../test/fakes/fake-anthropic.ts";
import { CLI, makeHome, makeRepo } from "../test/e2e/helpers.ts";
import { makeStubSession, text } from "../test/agent/helpers.ts";
import { requestSizes } from "../src/agent/budget.ts";
import { toolsForSession } from "../src/tools/registry.ts";
import { median, percentile, round } from "./stats.ts";
import type { MetricKey, PerfResults } from "./gate-lib.ts";

const MODEL_ID = "custom:Fake-Anthropic-0";
const LONG_ANSWER = Array.from({ length: 150 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog, again and again`).join("\n") + "\nEND-OF-ANSWER";

export interface BenchOptions { quick?: boolean; only?: string[] }

async function newEnv(turns: Parameters<typeof startFakeAnthropic>[0] = []) {
  const server = await startFakeAnthropic(turns);
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  const repo = makeRepo();
  return { server, home, repo, env: { ...process.env, RIGWELL_HOME: home } as Record<string, string> };
}

// ---- in-process TUI keystroke latency -------------------------------------------------------------------------------

export async function benchKeystrokesInProcess(samples = 300): Promise<{ p50: number; p95: number; max: number; n: number }> {
  const { server, home, repo } = await newEnv([() => ({ text: LONG_ANSWER })]);
  const prevHome = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = home;
  const { runTui } = await import("../src/tui/app.ts");
  const { inProcessTransport } = await import("../src/sdk/in-process.ts");

  const stdin: any = new EventEmitter();
  stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.resume = () => stdin;
  const stdout: any = new EventEmitter();
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 40;
  let onFrame: ((s: string) => void) | undefined;
  stdout.write = (s: string) => { onFrame?.(String(s)); return true; };

  const waitFrame = (pred: (s: string) => boolean, ms = 15000) => new Promise<string>((res, rej) => {
    const t = setTimeout(() => { onFrame = undefined; rej(new Error("timed out waiting for a frame")); }, ms);
    onFrame = (s) => { if (pred(s)) { clearTimeout(t); onFrame = undefined; res(s); } };
  });

  const done = runTui({
    cwd: repo, makeTransport: async () => inProcessTransport({ canPrompt: true }), sessionParams: { modelId: MODEL_ID },
    homeDir: home, stdin, stdout,
  });
  try {
    await waitFrame((s) => s.includes("\x1b[H"));
    stdin.emit("data", Buffer.from("seed the screen\r"));
    await waitFrame((s) => s.includes("END-OF-ANSWER"));
    await Bun.sleep(100);

    const times: number[] = [];
    const warm = 20;
    for (let i = 0; i < samples + warm; i++) {
      const key = i % 40 === 39 ? "\x7f".repeat(39) : String.fromCharCode(97 + (i % 26));
      const frame = waitFrame((s) => s.includes("\x1b[H"), 5000);
      const t0 = performance.now();
      stdin.emit("data", Buffer.from(key));
      await frame;
      const dt = performance.now() - t0;
      if (i >= warm) times.push(dt);
      await Bun.sleep(2);
    }
    return { p50: median(times), p95: percentile(times, 95), max: Math.max(...times), n: times.length };
  } finally {
    stdin.emit("data", Buffer.from("\x15/quit\r"));
    await Promise.race([done, Bun.sleep(3000)]);
    if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    server.stop();
  }
}

// ---- pty runs: first paint, first prompt, keystroke p95, quit --------------------------------------------------------

export async function benchPty(keys = 100): Promise<Partial<Record<MetricKey, number>>> {
  const { server, home, repo, env } = await newEnv([() => ({ text: LONG_ANSWER })]);
  let onData: ((s: string) => void) | undefined;
  const t0 = performance.now();
  const proc: any = Bun.spawn(["bun", CLI, "-m", MODEL_ID, "--cwd", repo], {
    env: { ...env, TERM: "xterm-256color" },
    terminal: { cols: 120, rows: 40, data(_t: unknown, d: Uint8Array) { onData?.(new TextDecoder().decode(d)); } },
  } as any);
  const next = (pred: (s: string) => boolean, ms = 15000) => new Promise<string>((res, rej) => {
    const t = setTimeout(() => { onData = undefined; rej(new Error("pty: timed out")); }, ms);
    onData = (s) => { if (pred(s)) { clearTimeout(t); onData = undefined; res(s); } };
  });
  const out: Partial<Record<MetricKey, number>> = {};
  try {
    await next((s) => s.includes("\x1b[H"));
    out.firstPaintMs = performance.now() - t0;
    const echoed = next((s) => s.includes("z"));
    proc.terminal.write("z");
    await echoed;
    out.firstPromptAcceptedMs = performance.now() - t0;
    proc.terminal.write("\x7f");
    await Bun.sleep(100);
    // Put a long answer on screen, then time single keystrokes.
    const answer = next((s) => s.includes("END-OF-ANSWER"), 20000);
    proc.terminal.write("hello\r");
    await answer;
    await Bun.sleep(300);
    const times: number[] = [];
    for (let i = 0; i < keys + 10; i++) {
      const frame = next((s) => s.includes("\x1b[H"), 5000);
      const s0 = performance.now();
      proc.terminal.write(String.fromCharCode(97 + (i % 26)));
      await frame;
      if (i >= 10) times.push(performance.now() - s0);
      await Bun.sleep(5);
    }
    out.firstKeystrokePtyP95Ms = percentile(times, 95);
    proc.terminal.write("\x15");
    await Bun.sleep(50);
    const q0 = performance.now();
    proc.terminal.write("/quit\r");
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    out.quitMs = performance.now() - q0;
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    server.stop();
  }
  return out;
}

// ---- turn preparation, tool lookup ----------------------------------------------------------------------------------

export async function benchTurnPrep(turns = 15): Promise<{ cold: number; warmP95: number }> {
  const arrivals: number[] = [];
  const { server, home, repo } = await newEnv(Array.from({ length: turns }, () => () => { arrivals.push(performance.now()); return { text: "ok" }; }));
  const prevHome = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = home;
  const { RpcClient } = await import("../src/sdk/client.ts");
  const { inProcessTransport } = await import("../src/sdk/in-process.ts");
  const client = new RpcClient(inProcessTransport({ canPrompt: false }));
  try {
    await client.request("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL_ID, autonomyLevel: "high" });
    const times: number[] = [];
    for (let i = 0; i < turns; i++) {
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      client.onNotification = (_m, p) => { if (p.notification?.type === "agent_working_state_changed" && p.notification.newState === "idle") done(); };
      const t0 = performance.now();
      await client.request("add_user_message", { text: `turn ${i}` });
      await finished;
      times.push(arrivals[i]! - t0);
    }
    return { cold: times[0]!, warmP95: percentile(times.slice(1), 95) };
  } finally {
    await client.request("close_session", { reason: "other" }).catch(() => {});
    await client.close().catch(() => {});
    if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    server.stop();
  }
}

export function benchToolLookup(iterations = 2000): number {
  for (let i = 0; i < 100; i++) toolsForSession({ autonomy: "high", skipPermissions: false });
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) toolsForSession({ autonomy: "high", skipPermissions: false });
  return (performance.now() - t0) / iterations;
}

// ---- process level: exec, daemon, memory ----------------------------------------------------------------------------

export async function benchExec(runs = 5): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    let arrived = 0;
    const { server, repo, env } = await newEnv([() => { arrived = performance.now(); return { text: "ok" }; }]);
    const t0 = performance.now();
    const proc = Bun.spawn(["bun", CLI, "exec", "-m", MODEL_ID, "--cwd", repo, "hello"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    server.stop();
    if (arrived) times.push(arrived - t0);
  }
  return median(times);
}

const rssMb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : NaN;
};

async function startDaemonProc(env: Record<string, string>, socket: string) {
  const t0 = performance.now();
  const proc = Bun.spawn(["bun", CLI, "daemon", "--socket", socket, "--no-ws"], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    if (buf.includes("listening")) break;
  }
  return { proc, readyMs: performance.now() - t0 };
}

export async function benchDaemon(runs = 5, sessions = 10): Promise<{ readyMs: number; perSessionMb?: number }> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { home, env } = await newEnv();
    const { proc, readyMs } = await startDaemonProc({ ...env, RIGWELL_HOME: home }, join(home, "d.sock"));
    times.push(readyMs);
    proc.kill();
    await proc.exited;
  }
  // Memory: one daemon, open N sessions over the socket.
  const { home, repo, env } = await newEnv();
  const sock = join(home, "d.sock");
  const { proc } = await startDaemonProc(env, sock);
  let perSessionMb: number | undefined;
  try {
    const { SocketTransport } = await import("../src/sdk/transport.ts");
    const { RpcClient } = await import("../src/sdk/client.ts");
    const open = async () => {
      const c = new RpcClient(await SocketTransport.connect(sock));
      await c.request("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL_ID });
      return c;
    };
    const first = await open(); // warm-up session: the first one pays for lazy module loading
    await Bun.sleep(300);
    const before = rssMb(proc.pid);
    const clients = [first];
    for (let i = 0; i < sessions; i++) clients.push(await open());
    await Bun.sleep(300);
    perSessionMb = (rssMb(proc.pid) - before) / sessions;
    for (const c of clients) await c.close().catch(() => {});
  } catch { /* leave undefined: not measured */ } finally {
    proc.kill();
    await proc.exited;
  }
  return { readyMs: median(times), perSessionMb };
}

// ---- base prompt ----------------------------------------------------------------------------------------------------

export async function measureBasePrompt(): Promise<PerfResults["basePrompt"]> {
  const out: any = {};
  for (const mode of ["direct_only", "script_only"] as const) {
    const s = makeStubSession(() => text("ok"), { toolExecutionModeOverride: mode });
    s.session.addUserMessage("hi");
    await s.session.settled();
    const req = s.requests[0]!;
    const sz = requestSizes(req);
    out[mode] = { systemChars: sz.systemChars, toolsChars: sz.toolsChars };
    if (mode === "direct_only") out.contextChars = req.messages[0]!.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
  }
  return out;
}

// ---- all ------------------------------------------------------------------------------------------------------------

export async function runBenchmarks(opts: BenchOptions = {}): Promise<PerfResults> {
  const want = (k: string) => !opts.only || opts.only.includes(k);
  const q = !!opts.quick;
  const metrics: PerfResults["metrics"] = {};
  const notes: string[] = [];
  const log = (m: string) => process.stderr.write(`[perf] ${m}\n`);

  if (want("keystroke")) {
    log("first-keystroke (in-process)");
    const k = await benchKeystrokesInProcess(q ? 100 : 300);
    metrics.firstKeystrokeP95Ms = round(k.p95);
    metrics.firstKeystrokeP50Ms = round(k.p50);
    notes.push(`First-keystroke (gated): ${k.n} keystrokes through runTui with a fake TTY and an in-process session, long answer on screen; stdin data event to redrawn frame written to stdout. p50 ${round(k.p50)} ms, max ${round(k.max)} ms.`);
  }
  if (want("lookup")) metrics.preflightToolLookupMs = round(benchToolLookup(), 4);
  if (want("turn")) {
    log("turn preparation");
    const t = await benchTurnPrep(q ? 6 : 15);
    metrics.turnPrepColdMs = round(t.cold);
    metrics.turnPrepWarmP95Ms = round(t.warmP95);
  }
  if (want("exec")) {
    log("exec first request");
    metrics.execFirstRequestMs = round(await benchExec(q ? 2 : 5));
  }
  if (want("daemon")) {
    log("daemon ready and memory");
    const d = await benchDaemon(q ? 2 : 5, q ? 5 : 10);
    metrics.daemonReadyMs = round(d.readyMs);
    if (d.perSessionMb !== undefined && Number.isFinite(d.perSessionMb)) metrics.perSessionMemoryMb = round(d.perSessionMb);
  }
  if (want("pty")) {
    log("pty runs (first paint, first prompt, keystroke p95, quit)");
    try {
      const p = await benchPty(q ? 40 : 100);
      for (const [k, v] of Object.entries(p)) (metrics as any)[k] = round(v as number);
    } catch (e) {
      notes.push(`pty benchmarks skipped: ${(e as Error).message}`);
    }
  }
  const basePrompt = await measureBasePrompt();
  return { metrics, basePrompt, notes };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const res = await runBenchmarks({ quick: a.includes("--quick"), only: val("--only")?.split(",") });
  const out = val("--out");
  if (out) writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

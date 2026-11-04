// Daemon supervisor (spec §14.1): the app owns one daemon child process, watches it and restarts it when it dies.
// Plain Node APIs only, so it runs in Electron's main process and under Bun in tests.
//
// States: stopped -> starting -> running -> stopping -> stopped.
// Ready: the child has written $RIGWELL_HOME/daemon.json with its own pid and token, and its WebSocket port answers
// (an unauthenticated request gets HTTP 401, which proves the listener is up) within readyTimeoutMs (30 s).
// Auto-restart: up to 3 times with waits of 2 s, 4 s, 8 s; the count resets once a start reaches ready.
// stderr goes to <home>/logs/daemon-stderr.log, rotated at 1 MB to daemon-stderr.log.old; a crash breadcrumb goes to
// <home>/logs/daemon-critical-error.json.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonSocketPath } from "../../src/daemon/socket-path.ts";

export type SupervisorState = "stopped" | "starting" | "running" | "stopping";

export interface DaemonInfo { pid: number; socketPath: string; wsUrl: string; token: string; startedAt: string }

export interface SupervisorOptions {
  /** RIGWELL_HOME for the daemon (also where daemon.json and logs live). */
  home: string;
  /** Command that starts the daemon, e.g. ["bun", "/path/src/cli/main.ts"]; `daemon --socket ... --ws-port 0` is appended. */
  command: string[];
  env?: Record<string, string | undefined>;
  /** Waits before restart attempts 1, 2, 3. Default 2000, 4000, 8000. */
  backoffMs?: number[];
  readyTimeoutMs?: number;
  /** Rotate the stderr log above this size. Default 1 MB. */
  logMaxBytes?: number;
  log?: (m: string) => void;
}

/** Text for the start-failure dialog: the likely causes (spec §14.1). */
export const START_FAILURE_HINT =
  "The background service did not start. Common causes: antivirus software quarantined it, a firewall is blocking loopback connections, " +
  "a policy blocks starting the program, or another program is using the port.";

export function readDaemonInfo(home: string): { pid: number; socketPath: string; ws?: { url: string; port: number }; token?: string; startedAt: string } | undefined {
  try { return JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")); } catch { return undefined; }
}

/** True when something answers on the daemon's WebSocket port (401 without a token is the expected answer). */
export async function probeDaemon(wsUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const u = new URL(wsUrl);
    const r = await fetch(`http://${u.host}/`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 401 || r.status === 426;
  } catch { return false; }
}

export class DaemonSupervisor extends EventEmitter {
  private _state: SupervisorState = "stopped";
  private child?: ChildProcess;
  private _info?: DaemonInfo;
  private attempts = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private wantRunning = false;
  private generation = 0;

  constructor(private opts: SupervisorOptions) { super(); }

  get state() { return this._state; }
  get info() { return this._info; }
  get pid() { return this.child?.pid; }
  private get logDir() { return join(this.opts.home, "logs"); }
  private log(m: string) { this.opts.log?.(`[supervisor] ${m}`); }

  private setState(s: SupervisorState) {
    if (this._state === s) return;
    this._state = s;
    this.emit("state", s);
  }

  /** Starts the daemon and resolves when it is ready. Rejects when the first start fails. */
  async start(): Promise<DaemonInfo> {
    if (this._state === "running" && this._info) return this._info;
    this.wantRunning = true;
    return this.launch();
  }

  /** Manual restart: stop, then start fresh with a reset failure count. */
  async restart(): Promise<DaemonInfo> {
    await this.stop();
    this.attempts = 0;
    return this.start();
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    clearTimeout(this.restartTimer);
    this.generation++;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this.child = undefined; this._info = undefined; this.setState("stopped"); return; }
    this.setState("stopping");
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(killer);
    this.child = undefined;
    this._info = undefined;
    this.setState("stopped");
  }

  private async launch(): Promise<DaemonInfo> {
    const gen = ++this.generation;
    this.setState("starting");
    mkdirSync(this.logDir, { recursive: true });
    this.rotateLog();
    const socketPath = daemonSocketPath(this.opts.home);
    const [cmd, ...rest] = this.opts.command;
    const child = spawn(cmd, [...rest, "daemon", "--socket", socketPath, "--ws-port", "0"], {
      env: { ...process.env, ...this.opts.env, RIGWELL_HOME: this.opts.home } as NodeJS.ProcessEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let stderrTail = "";
    child.stderr!.on("data", (b: Buffer) => {
      const t = b.toString();
      stderrTail = (stderrTail + t).slice(-4000);
      try { appendFileSync(join(this.logDir, "daemon-stderr.log"), t); } catch {}
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (e) => { stderrTail += `\nspawn error: ${e.message}`; resolve({ code: null, signal: "spawn_error" }); });
    });
    void exit.then((r) => this.onExit(gen, child, r, stderrTail));

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30_000);
    for (;;) {
      if (gen !== this.generation) throw new Error("Daemon start was cancelled");
      const info = readDaemonInfo(this.opts.home);
      if (info && info.pid === child.pid && info.ws && info.token && (await probeDaemon(info.ws.url))) {
        this._info = { pid: info.pid, socketPath: info.socketPath, wsUrl: info.ws.url, token: info.token, startedAt: info.startedAt };
        this.attempts = 0;
        this.setState("running");
        this.emit("ready", this._info);
        return this._info;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Daemon exited during start (${startErrorLine(stderrTail)})`);
      if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("Daemon was not ready within the time limit"); }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private onExit(gen: number, child: ChildProcess, r: { code: number | null; signal: string | null }, stderrTail: string) {
    if (this.child === child) this.child = undefined;
    if (gen !== this.generation && !this.wantRunning) return; // a requested stop
    this._info = undefined;
    this.log(`daemon exited (code ${r.code}, signal ${r.signal})`);
    try {
      writeFileSync(join(this.logDir, "daemon-critical-error.json"), JSON.stringify({ at: new Date().toISOString(), pid: child.pid, code: r.code, signal: r.signal, stderrTail }, null, 2));
    } catch {}
    if (!this.wantRunning) { this.setState("stopped"); return; }
    this.setState("stopped");
    this.emit("exited", r);
    const waits = this.opts.backoffMs ?? [2000, 4000, 8000];
    if (this.attempts >= waits.length) {
      this.wantRunning = false;
      this.emit("failed", new Error(`${START_FAILURE_HINT} (gave up after ${waits.length} restarts)`));
      return;
    }
    const wait = waits[this.attempts++];
    this.log(`restart ${this.attempts} in ${wait} ms`);
    this.emit("restarting", { attempt: this.attempts, waitMs: wait });
    this.restartTimer = setTimeout(() => {
      if (!this.wantRunning) return;
      this.launch().catch((e) => this.log(`restart failed: ${(e as Error).message}`));
    }, wait);
  }

  private rotateLog() {
    const f = join(this.logDir, "daemon-stderr.log");
    try {
      if (existsSync(f) && statSync(f).size > (this.opts.logMaxBytes ?? 1024 * 1024)) renameSync(f, f + ".old");
    } catch {}
  }
}

/**
 * The stderr line that says why a start failed. Bun prints the error line first and its own version line last
 * ("Bun v1.4.4 (Windows x64)"), so the last line alone hides the cause: prefer the last line that says "error".
 */
export function startErrorLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [...lines].reverse().find((l) => /error/i.test(l)) ?? lines.at(-1) ?? "no output";
}

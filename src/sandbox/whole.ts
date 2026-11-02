// Whole-process sandbox mode (spec 5.5.8 `whole-process`), Linux / bubblewrap.
//
// The spec relaunches the whole agent inside the sandbox. Rigwell's agent loop stays outside (it needs the network and
// the model keys), so what is relaunched is the agent's command execution path: ONE long-lived bubblewrap process per
// session, started with the effective policy, runs a small worker. Every Execute command is sent to that worker over a
// control channel (a Unix socket in a private directory) and runs inside the already-built sandbox, so mounts, the
// network proxy bridge and the seccomp filter are set up once, not per command.
//
//   host                                   sandbox (bwrap, policy P, seccomp)
//   Execute -> spawn client.js ---socket--> worker.js -> sh -c "<command>" (own process group)
//              relays stdout / stderr / exit      kills the group when the client goes away (timeout, cancel)
//
// The client is a short-lived process, so the Execute tool needs no change: it spawns the client like it would spawn bwrap,
// and kills the client's process group on timeout or cancel; the worker sees the connection close and kills the command.
//
// Policy hash: sha256 over the effective policy plus the engine and filter switches. The worker reports the hash it was
// started with (`hello`); the controller compares it with the hash of the CURRENT policy before each command. A changed
// policy (a new "allow always", an "allow for this session" grant) means different mounts, so the worker is relaunched.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildBwrapArgs, bwrapExec, PROXY_INNER_PORT, proxyEnv, SECCOMP_FD, type EngineInfo } from "./engine.ts";
import type { SandboxPolicy } from "./policy.ts";
import { startProxy, type ProxyHandle } from "./proxy.ts";
import type { SandboxViolation } from "./violations.ts";
import { CLIENT_SOURCE, WORKER_SOURCE } from "./whole-sources.ts";

/** Stable hash of the effective policy and the switches that change how the sandbox is built. */
export function policyHash(policy: SandboxPolicy, engine: string, seccomp: boolean): string {
  const canon = JSON.stringify({
    engine, seccomp,
    writable: [...policy.writable].sort(), readOnly: [...policy.readOnly].sort(), unreadable: [...policy.unreadable].sort(), readAllowed: [...policy.readAllowed].sort(),
    network: { ...policy.network, allowedDomains: [...policy.network.allowedDomains].sort(), deniedDomains: [...policy.network.deniedDomains].sort() },
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

const bunPath = () => (path.basename(process.execPath).startsWith("bun") ? process.execPath : Bun.which("bun") ?? process.execPath);

export interface WorkerInfo {
  policyHash: string;
  /** pid of the bubblewrap process on the host */
  pid: number;
  socket: string;
  /** the command a caller spawns to run `command` in the sandbox: bun client.js <socket> <cwd> <shell> <command> */
  clientScript: string;
  proxyEnv: Record<string, string>;
}

export class WholeProcessWorker {
  private proc?: ChildProcess;
  private dir?: string;
  private proxy?: ProxyHandle;
  private proxyDir?: string;
  private info?: WorkerInfo;
  private starting?: Promise<WorkerInfo>;
  /** Network violations seen by the proxy since the worker started (each command takes the ones after its start index). */
  readonly netViolations: SandboxViolation[] = [];

  constructor(private o: { seccompFile?: string | null; log?: (m: string) => void } = {}) {}

  get current(): WorkerInfo | undefined { return this.info; }
  get running(): boolean { return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null; }

  /** Returns a worker running with `policy`: reuses the live one when the hash matches, else relaunches. */
  async ensure(policy: SandboxPolicy, eng: EngineInfo): Promise<WorkerInfo> {
    const hash = policyHash(policy, eng.engine, !!this.o.seccompFile);
    if (this.running && this.info?.policyHash === hash) return this.info;
    if (this.starting) {
      const s = await this.starting;
      if (s.policyHash === hash) return s;
    }
    await this.stop();
    this.starting = this.start(policy, eng, hash).finally(() => { this.starting = undefined; });
    return await this.starting;
  }

  private async start(policy: SandboxPolicy, eng: EngineInfo, hash: string): Promise<WorkerInfo> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rigwell-sbxw-"));
    this.dir = dir;
    const socket = path.join(dir, "ctl.sock");
    const workerJs = path.join(dir, "worker.js");
    const clientJs = path.join(dir, "client.js");
    fs.writeFileSync(workerJs, WORKER_SOURCE);
    fs.writeFileSync(clientJs, CLIENT_SOURCE);
    let proxySocket: string | undefined;
    const penv: Record<string, string> = {};
    if (policy.network.rule === "proxy" && eng.socat) {
      this.proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigwell-sbxp-"));
      proxySocket = path.join(this.proxyDir, "proxy.sock");
      this.proxy = await startProxy({
        allowed: policy.network.allowedDomains, denied: policy.network.deniedDomains, listen: { unix: proxySocket },
        onViolation: (v) => this.netViolations.push({ type: "network", reason: v.reason, target: v.host, command: "(whole-process sandbox)", at: Date.now() }),
      });
      Object.assign(penv, proxyEnv(PROXY_INNER_PORT));
    }
    // The control directory is the one writable bind besides the policy's own: the worker creates its socket there.
    const base = buildBwrapArgs({ policy, proxySocket, socat: eng.socat, seccompFd: this.o.seccompFile ? SECCOMP_FD : undefined });
    const argv = [...base, "--bind", dir, dir];
    const workerCmd = [bunPath(), workerJs, socket, hash];
    const { file, args } = bwrapExec(eng.bin!, argv, workerCmd, { proxySocket, socat: eng.socat, seccompFile: this.o.seccompFile ?? undefined });
    const proc = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.proc = proc;
    let err = "";
    proc.stderr!.on("data", (b: Buffer) => { err += b.toString(); if (err.length > 4000) err = err.slice(-4000); });
    const ready = new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`the sandbox worker did not start in 10 s${err ? `: ${err.trim()}` : ""}`)), 10_000);
      proc.stdout!.on("data", (b: Buffer) => {
        out += b.toString();
        if (out.includes('"t":"ready"')) { clearTimeout(timer); resolve(); }
      });
      proc.on("exit", (code, sig) => { clearTimeout(timer); reject(new Error(`the sandbox worker exited (${code ?? sig})${err ? `: ${err.trim()}` : ""}`)); });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    try {
      await ready;
      const hello = await this.hello(socket);
      if (hello.policyHash !== hash) throw new Error(`the sandbox worker reports policy ${hello.policyHash}, expected ${hash}`);
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.info = { policyHash: hash, pid: proc.pid!, socket, clientScript: clientJs, proxyEnv: penv };
    this.o.log?.(`[sandbox] whole-process worker up (policy ${hash}, pid ${proc.pid})`);
    return this.info;
  }

  /** Asks the worker for its hello (policy hash, pid) over the control channel. */
  hello(socket = this.info?.socket ?? ""): Promise<{ policyHash: string; pid: number }> {
    return new Promise((resolve, reject) => {
      const c = net.connect(socket);
      let buf = "";
      const timer = setTimeout(() => { c.destroy(); reject(new Error("the sandbox worker did not answer hello")); }, 5000);
      c.on("connect", () => c.write(JSON.stringify({ t: "hello" }) + "\n"));
      c.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e as Error); }
        c.destroy();
      });
      c.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.info = undefined;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise<void>((r) => proc.once("exit", () => r()));
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 2000))]);
    }
    await this.proxy?.close().catch(() => {});
    this.proxy = undefined;
    for (const d of [this.dir, this.proxyDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
    this.dir = this.proxyDir = undefined;
  }

  /** The spawn line for one command: runs the client, which relays the command through the worker. */
  clientCommand(info: WorkerInfo, shell: string, command: string, cwd: string): { file: string; args: string[] } {
    return { file: bunPath(), args: [info.clientScript, info.socket, cwd, shell, command] };
  }
}

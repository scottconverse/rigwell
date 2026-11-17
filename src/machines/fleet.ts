import { posix, win32 } from "node:path";
import { MachineStore, type Machine } from "./store.ts";
import { bootstrapMachine, connectMachine } from "./bootstrap.ts";
import { remoteCommand, runSsh } from "./ssh.ts";
import type { RpcClient } from "../sdk/client.ts";
import type { machineRuntimeInfo } from "./runtime-info.ts";

export type MachineRuntime = ReturnType<typeof machineRuntimeInfo>;
export interface FleetMachine extends Machine {
  online: boolean;
  runningSessions: number | null;
  load: MachineRuntime["load"] | null;
  error?: string;
}
export interface FleetOptions {
  store?: MachineStore;
  connect?: (name: string) => Promise<RpcClient>;
  bootstrap?: (name: string) => Promise<Machine>;
  run?: typeof runSsh;
  now?: () => Date;
}
export class MachineFleet {
  readonly store: MachineStore;
  constructor(private opts: FleetOptions = {}) { this.store = opts.store ?? new MachineStore(); }
  private connect(name: string) { return (this.opts.connect ?? ((name) => connectMachine(name, { store: this.store })))(name); }
  async list(): Promise<FleetMachine[]> {
    const results: FleetMachine[] = [];
    for (const machine of this.store.list()) {
      let client: RpcClient | undefined;
      try {
        client = await this.connect(machine.name);
        const info = await client.request<MachineRuntime>("machine_runtime_info");
        if (info.build !== machine.build || !["win32", "linux", "darwin"].includes(info.platform) || !Number.isSafeInteger(info.runningSessions) || info.runningSessions < 0) throw new Error("Invalid remote machine status");
        const current = this.store.get(machine.name);
        // Do not overwrite a concurrently replaced connection definition with a stale probe.
        const same = current.host === machine.host && current.build === machine.build && current.root === machine.root;
        const lastSeen = (this.opts.now?.() ?? new Date()).toISOString();
        if (same) this.store.save({ ...current, platform: info.platform as Machine["platform"], version: info.version, daemonPid: info.pid, lastSeen }, true);
        results.push({ ...machine, platform: info.platform as Machine["platform"], version: info.version, lastSeen, online: true, runningSessions: info.runningSessions, load: info.load });
      } catch (e) { results.push({ ...machine, online: false, runningSessions: null, load: null, error: (e as Error).message }); }
      finally { await client?.close(); }
    }
    return results;
  }
  async stop(name: string) {
    const client = await this.connect(name);
    try { return await client.request("machine_stop_sessions"); } finally { await client.close(); }
  }
  remove(name: string) { this.store.remove(name); return { removed: true }; }
  private async shutdown(name: string) {
    const machine = this.store.get(name), client = await this.connect(name);
    try {
      const result = await client.request<{ shuttingDown?: boolean }>("machine_shutdown", { build: machine.build });
      if (result.shuttingDown !== true) throw new Error("Remote daemon did not acknowledge shutdown; no replacement was started");
      const deadline = Date.now() + 10_000;
      while (!client.isClosed && Date.now() < deadline) await Bun.sleep(20);
      if (!client.isClosed) throw new Error("Remote daemon did not confirm shutdown; no replacement was started");
    } finally { await client.close(); }
    return machine;
  }
  private async start(machine: Machine) {
    if (!machine.root || !machine.build || !machine.platform) throw new Error("Bootstrap the machine first");
    const paths = machine.platform === "win32" ? win32 : posix;
    const args = [paths.join(machine.root, machine.platform === "win32" ? "bun.exe" : "bun"), paths.join(machine.root, "src/machines/remote-start.ts"), machine.root, machine.build];
    const result = await (this.opts.run ?? runSsh)(machine, remoteCommand(machine, args), { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`Remote daemon restart failed: ${result.stderr || result.stdout}`);
    const info = JSON.parse(result.stdout.trim()) as MachineRuntime;
    if (info.build !== machine.build || !Number.isSafeInteger(info.pid) || info.pid < 1) throw new Error("Restarted daemon did not match its saved build");
    return this.store.save({ ...machine, daemonPid: info.pid, lastSeen: (this.opts.now?.() ?? new Date()).toISOString() }, true);
  }
  async restart(name: string) { return this.start(await this.shutdown(name)); }
  async update(name: string) {
    const original = this.store.get(name);
    // First installation has no old daemon to stop.
    if (original.build) await this.shutdown(name);
    try { return await (this.opts.bootstrap ?? ((name) => bootstrapMachine(name, { store: this.store })))(name); }
    catch (error) {
      // Retain the verified previous build when installation fails before recording a replacement.
      if (original.build && this.store.get(name).build === original.build) {
        try { await this.start(original); }
        catch (recovery) { throw new Error(`${(error as Error).message}; previous daemon recovery failed: ${(recovery as Error).message}`); }
      }
      throw error;
    }
  }
  async updateAll() {
    const results: { name: string; machine?: Machine; error?: string }[] = [];
    for (const { name } of this.store.list()) {
      try { results.push({ name, machine: await this.update(name) }); }
      catch (e) { results.push({ name, error: (e as Error).message }); }
    }
    return { results };
  }
}

// Renderer-owned channels. VNC bytes cross guarded IPC, so no additional renderer network access is needed.
import { MachineStore } from "../../src/machines/store.ts";
import { openBrowserTunnel, openSshStream, remotePort } from "../../src/machines/tunnel.ts";

type Stream = ReturnType<typeof openSshStream>;
type Lease = { owner: number; close(): Promise<void>; stream?: Stream; waiting?: boolean; timer?: ReturnType<typeof setTimeout> };
export class RemoteViews {
  private leases = new Map<string, Lease>();
  constructor(private home: string, private emit: (owner: number, event: { id: string; data?: Uint8Array; closed?: boolean; error?: string }) => void, private executable?: string[]) {}
  async open(owner: number, name: string, port: number, kind: "browser" | "desktop") {
    remotePort(port);
    if (!["browser", "desktop"].includes(kind)) throw new Error("Invalid viewer kind");
    if ([...this.leases.values()].filter((l) => l.owner === owner).length >= 8) throw new Error("Close an existing remote viewer first");
    const machine = new MachineStore(this.home).get(name);
    if (!machine.build) throw new Error("Bootstrap the machine first");
    const id = crypto.randomUUID();
    if (kind === "browser") {
      // Reserve the slot before asynchronous listener startup.
      let tunnel: Awaited<ReturnType<typeof openBrowserTunnel>> | undefined, cancelled = false;
      const lease: Lease = { owner, close: async () => { cancelled = true; await tunnel?.close(); } };
      this.leases.set(id, lease);
      try {
        tunnel = await openBrowserTunnel(machine, port, this.executable);
        if (cancelled) { await tunnel.close(); throw new Error("Viewer owner closed"); }
        return { id, url: tunnel.url };
      } catch (e) { this.leases.delete(id); throw e; }
    }
    const stream = openSshStream(machine, port, this.executable);
    stream.child.stdout.pause();
    const lease: Lease = { owner, stream, close: () => stream.close() };
    this.leases.set(id, lease);
    stream.child.stdout.on("data", (data: Buffer) => {
      stream.child.stdout.pause(); lease.waiting = true;
      lease.timer = setTimeout(() => { void this.close(owner, id); }, 15_000);
      this.emit(owner, { id, data: new Uint8Array(data) });
    });
    void stream.closed.then(() => {
      clearTimeout(lease.timer); this.leases.delete(id);
      this.emit(owner, { id, closed: true, ...(stream.child.exitCode !== 0 ? { error: stream.error() || "SSH viewer channel closed" } : {}) });
    });
    return { id };
  }
  private owned(owner: number, id: string) {
    const lease = this.leases.get(id);
    if (!lease || lease.owner !== owner) throw new Error("Unknown viewer channel");
    return lease;
  }
  receive(owner: number, id: string) {
    const lease = this.owned(owner, id);
    clearTimeout(lease.timer); lease.waiting = false; lease.stream?.child.stdout.resume();
  }
  async send(owner: number, id: string, data: unknown) {
    const lease = this.owned(owner, id);
    if (!(data instanceof Uint8Array) || data.byteLength > 1024 * 1024 || !lease.stream) throw new Error("Invalid viewer data");
    const input = lease.stream.child.stdin;
    if (input.writableLength + data.byteLength > 2 * 1024 * 1024) { await this.close(owner, id); throw new Error("Viewer send buffer exceeded"); }
    await new Promise<void>((resolve, reject) => input.write(data, (e) => e ? reject(e) : resolve()));
  }
  async close(owner: number, id: string) {
    const lease = this.leases.get(id);
    if (!lease) return;
    if (lease.owner !== owner) throw new Error("Unknown viewer channel");
    this.leases.delete(id); clearTimeout(lease.timer); await lease.close();
  }
  async closeOwner(owner: number) { await Promise.all([...this.leases].filter(([, l]) => l.owner === owner).map(([id]) => this.close(owner, id))); }
  async closeAll() { await Promise.all([...this.leases].map(([id, l]) => this.close(l.owner, id))); }
}

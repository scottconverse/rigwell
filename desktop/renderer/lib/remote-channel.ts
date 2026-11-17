import { bridge } from "./rpc.ts";

/** A binary channel implementing noVNC's raw-channel interface over the guarded preload bridge. */
export class RemoteChannel {
  binaryType = "arraybuffer";
  protocol = "";
  readyState = "connecting";
  onopen: () => void = () => {};
  onerror: (error: unknown) => void = () => {};
  onmessage: (event: { data: ArrayBuffer }) => void = () => {};
  onclose: (event: { code: number; reason: string; wasClean: boolean }) => void = () => {};
  private off?: () => void;
  private opening?: Promise<void>;
  private id?: string;
  constructor(private machine: string, private port: number) {}
  start() {
    return this.opening ??= (async () => {
      const api = bridge().remoteView;
      const { id } = await api.open(this.machine, this.port, "desktop");
      this.id = id;
      if (this.readyState === "closed") { await api.close(id); return; }
      this.off = api.onData((event) => {
        if (event.id !== id || this.readyState !== "open") return;
        if (event.closed) { this.finish(!event.error, event.error ?? ""); return; }
        if (event.data) {
          try { this.onmessage({ data: new Uint8Array(event.data).buffer }); }
          catch (e) { this.onerror(e); this.close(); return; }
          void api.receive(id).catch((e) => this.fail(e));
        }
      });
      this.readyState = "open"; this.onopen();
      await api.receive(id);
    })().catch((e) => this.fail(e));
  }
  send(data: Uint8Array) {
    if (this.readyState !== "open" || !this.id) throw new Error("Viewer channel is closed");
    // Copy noVNC's reusable send queue before crossing the asynchronous bridge.
    void bridge().remoteView.send(this.id, data.slice()).catch((e) => this.fail(e));
  }
  private fail(error: unknown) { if (this.readyState === "closed") return; this.onerror(error); this.close(); }
  private finish(clean: boolean, reason: string) {
    if (this.readyState === "closed") return;
    this.readyState = "closed"; this.off?.(); this.off = undefined;
    this.onclose({ code: clean ? 1000 : 1006, reason, wasClean: clean });
  }
  close() { this.finish(true, ""); if (this.id) void bridge().remoteView.close(this.id).catch(() => {}); }
}

// Transports for the SDK client (spec §3.1.1). A transport moves whole JSON messages (no trailing newline).
// Stream transports (child process, Unix socket) split NDJSON; WebSocket carries one message per text frame.
import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";

export interface Transport {
  /** Send one JSON message. */
  write(message: string): void;
  /** Set by the client before use. */
  onMessage: (message: string) => void;
  /** Called once when the transport ends. */
  onClose: (error?: Error) => void;
  /** Close the transport. Resolves when it is fully closed. */
  close(): Promise<void>;
}

/** Splits an incoming byte stream into lines: LF delimiter, trailing CR dropped (spec §3.1.1 Reader). */
export class LineSplitter {
  private buf = "";
  constructor(private emit: (line: string) => void) {}
  push(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.emit(line);
    }
  }
}

const LS = new RegExp("\\u2028", "g");
const PS = new RegExp("\\u2029", "g");
/** Serializes one message as an NDJSON line (U+2028/U+2029 escaped). */
export const toLine = (message: string) => message.replace(LS, "\\u2028").replace(PS, "\\u2029") + "\n";

export interface SpawnOptions {
  /** Command and leading args that start rigwell. Default: bun running this repo's CLI. */
  command?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Extra args appended after `exec --input-format stream-jsonrpc --output-format stream-jsonrpc`. */
  extraArgs?: string[];
  /** Extra settings file for this process (runtime level). */
  settingsPath?: string;
  /** Receives the child's stderr (logging only, never protocol data). */
  onStderr?: (text: string) => void;
  /** Shutdown timings (default 2000 and 3000), exposed for tests. */
  gracefulMs?: number;
  killMs?: number;
}

const DEFAULT_CLI = new URL("../cli/main.ts", import.meta.url).pathname;

export class SpawnTransport implements Transport {
  onMessage: (m: string) => void = () => {};
  onClose: (e?: Error) => void = () => {};
  readonly proc: ChildProcess;
  private exited: Promise<void>;
  private ended = false;

  constructor(private opts: SpawnOptions = {}) {
    const base = opts.command ?? ["bun", DEFAULT_CLI];
    const args = [...base.slice(1), "exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"];
    if (opts.settingsPath) args.push("--settings", opts.settingsPath);
    args.push(...(opts.extraArgs ?? []));
    this.proc = spawn(base[0], args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    const split = new LineSplitter((line) => {
      const t = line.trimStart();
      if (t[0] === "{" || t[0] === "[") this.onMessage(line);
      else opts.onStderr?.(`[non-JSON stdout] ${line}\n`); // skipped, per spec §3.1.1
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (c: string) => split.push(c));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (c: string) => opts.onStderr?.(c));
    this.proc.stdin!.on("error", () => {});
    this.exited = new Promise<void>((resolve) => {
      let done = false;
      const fin = (err?: Error) => { if (done) return; done = true; this.ended = true; this.onClose(err); resolve(); };
      this.proc.on("error", (e) => fin(e));
      // 'close' fires after stdio is drained, so every protocol line is delivered before onClose.
      this.proc.on("close", (code, signal) => fin(code === 0 || signal === "SIGTERM" ? undefined : new Error(`process exited with code ${code ?? signal}`)));
    });
  }

  write(message: string) {
    if (this.ended || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(toLine(message));
  }

  /** End stdin, wait 2 s, SIGTERM, then SIGKILL after 3 s more (spec §3.1.1). */
  async close() {
    if (this.ended) return;
    try { this.proc.stdin?.end(); } catch {}
    const wait = (ms: number) => new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), ms);
      void this.exited.then(() => { clearTimeout(t); res(true); });
    });
    if (await wait(this.opts.gracefulMs ?? 2000)) return;
    this.proc.kill("SIGTERM");
    if (await wait(this.opts.killMs ?? 3000)) return;
    this.proc.kill("SIGKILL");
    await this.exited;
  }
}

export class SocketTransport implements Transport {
  onMessage: (m: string) => void = () => {};
  onClose: (e?: Error) => void = () => {};
  private closedP: Promise<void>;

  private constructor(private sock: Socket) {
    const split = new LineSplitter((l) => this.onMessage(l));
    sock.setEncoding("utf8");
    sock.on("data", (c: string) => split.push(c));
    this.closedP = new Promise<void>((res) => {
      sock.on("error", (e) => { this.onClose(e); res(); });
      sock.on("close", () => { this.onClose(); res(); });
    });
  }

  static connect(path: string): Promise<SocketTransport> {
    return new Promise((resolve, reject) => {
      const sock = netConnect(path);
      sock.once("connect", () => resolve(new SocketTransport(sock)));
      sock.once("error", reject);
    });
  }

  write(message: string) { if (this.sock.writable) this.sock.write(toLine(message)); }
  async close() {
    this.sock.end();
    await Promise.race([this.closedP, new Promise((r) => setTimeout(r, 1000))]);
    this.sock.destroy();
  }
}

export class WebSocketTransport implements Transport {
  onMessage: (m: string) => void = () => {};
  onClose: (e?: Error) => void = () => {};
  private closedP: Promise<void>;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const t = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      this.onMessage(t.replace(/\n+$/, ""));
    });
    this.closedP = new Promise<void>((res) => {
      ws.addEventListener("close", () => { this.onClose(); res(); });
    });
  }

  /** `url` is the daemon's ws:// URL. The token goes in the `token` query parameter. */
  static connect(url: string, token?: string): Promise<WebSocketTransport> {
    const u = new URL(url);
    if (token) u.searchParams.set("token", token);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(u.toString());
      let opened = false;
      ws.addEventListener("open", () => { opened = true; resolve(new WebSocketTransport(ws)); }, { once: true });
      ws.addEventListener("error", () => { if (!opened) reject(new Error(`WebSocket connection to ${u.host} failed (check the URL and token)`)); }, { once: true });
      ws.addEventListener("close", (ev) => { if (!opened) reject(new Error(`WebSocket closed before opening (code ${ev.code})`)); }, { once: true });
    });
  }

  write(message: string) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message); }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await Promise.race([this.closedP, new Promise((r) => setTimeout(r, 1000))]);
  }
}

// Parent side of the Script sandbox: spawns the runner child process and speaks NDJSON to it.
// The child runs the program in a QuickJS WebAssembly context (see runner.ts); this class only
// relays tool calls and output, enforces the overall time limit and can kill the child at any time.
import { fileURLToPath } from "node:url";

export const RUNNER_PATH = fileURLToPath(new URL("./runner.ts", import.meta.url));

export interface SandboxLimits {
  /** Linear memory the guest may use. */
  memoryBytes: number;
  stackBytes: number;
  /** Longest stretch of synchronous guest code (an endless loop is stopped after this). */
  sliceMs: number;
  /** Wall time for the whole program, awaits included. */
  totalMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 256 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sliceMs: 120_000,
  totalMs: 2 * 60 * 60 * 1000,
};

export interface SandboxHandlers {
  onCall(id: number, name: string, input: string): void;
  onPrint(text: string): void;
  onImage(data: string, mime: string): void;
  onNotify(text: string): void;
}

export interface SandboxResult {
  ok: boolean;
  error?: { name?: string; message?: string; stack?: string };
  timedOut?: boolean;
  killed?: boolean;
}

export class Sandbox {
  private proc?: ReturnType<typeof Bun.spawn>;
  private done!: (r: SandboxResult) => void;
  readonly finished: Promise<SandboxResult>;
  private settled = false;
  private timer?: ReturnType<typeof setTimeout>;
  private buf = "";

  constructor(private handlers: SandboxHandlers, private limits: SandboxLimits = DEFAULT_LIMITS) {
    this.finished = new Promise((r) => (this.done = r));
  }

  start(code: string, inputs: Record<string, string>, toolNames: string[]): void {
    // The child gets a nearly empty environment: nothing it could leak even if the guest were broken.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    this.proc = Bun.spawn([process.execPath, RUNNER_PATH], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env });
    void this.pump();
    void this.proc.exited.then(() => this.finish({ ok: false, error: { name: "Error", message: "The Script sandbox process exited unexpectedly." } }));
    this.timer = setTimeout(() => {
      this.finish({ ok: false, timedOut: true, error: { name: "TimeoutError", message: `The Script ran past its time limit (${this.limits.totalMs} ms) and was stopped.` } });
    }, this.limits.totalMs);
    this.send({
      type: "run", code, inputs, toolNames,
      memoryBytes: this.limits.memoryBytes, stackBytes: this.limits.stackBytes, sliceMs: this.limits.sliceMs,
    });
  }

  reply(id: number, payload: unknown): void {
    this.send({ type: "reply", id, payload });
  }

  kill(): void {
    this.finish({ ok: false, killed: true, error: { name: "Error", message: "The Script was stopped." } });
  }

  private send(m: unknown): void {
    if (this.settled) return;
    try {
      (this.proc!.stdin as any).write(JSON.stringify(m) + "\n");
      (this.proc!.stdin as any).flush?.();
    } catch {
      /* child already gone: finish() runs from its exit handler */
    }
  }

  private finish(r: SandboxResult): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.proc?.kill("SIGKILL"); } catch { /* gone */ }
    this.done(r);
  }

  private async pump(): Promise<void> {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc!.stdout as ReadableStream<Uint8Array>) {
        this.buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (line.trim()) this.handle(line);
        }
      }
    } catch { /* stream closed */ }
  }

  private handle(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (this.settled) return;
    switch (m.type) {
      case "call": this.handlers.onCall(m.id, String(m.name), String(m.input)); break;
      case "print": this.handlers.onPrint(String(m.text)); break;
      case "image": this.handlers.onImage(String(m.data), String(m.mime)); break;
      case "notify": this.handlers.onNotify(String(m.text)); break;
      case "done": this.finish({ ok: !!m.ok, error: m.error }); break;
    }
  }
}

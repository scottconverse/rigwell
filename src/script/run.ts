// One Script run: owns the sandbox process, relays inner tool calls to the session, enforces the
// output and size caps (spec §5.2 limits table) and keeps the result log.
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolOutput } from "../core/types.ts";
import type { Job, JobStatus } from "../jobs/manager.ts";
import { structure, ToolCallError } from "./bindings.ts";
import type { ParsedScript } from "./parse.ts";
import { ResultLog, scriptsDir } from "./resultlog.ts";
import { Sandbox, DEFAULT_LIMITS, type SandboxLimits } from "./sandbox.ts";

export const LIMITS = {
  maxInflight: 128,
  resultBytes: 5 * 1024 * 1024,
  events: 1024,
  outputBytes: 5 * 1024 * 1024,
  printedBytes: 64 * 1024,
  echoBytes: 32 * 1024,
  errorsShown: 50,
};

/** What the session provides for each inner call. Throws ToolCallError when the call is refused. */
export interface ScriptHost {
  cwd: string;
  callTool(name: string, input: Record<string, unknown>, meta: { runId: string; n: number; outerId: string; signal: AbortSignal; foreground: boolean }): Promise<ToolOutput>;
  notify(text: string): void;
}

/** Keeps the head and the tail of what was printed, within the 64 KiB budget. */
export class PrintBuffer {
  private head = "";
  private tail = "";
  private cut = 0;
  private half = LIMITS.printedBytes / 2;
  push(s: string): void {
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) {
      this.tail += s;
      if (this.tail.length > this.half) {
        const drop = this.tail.length - this.half;
        this.cut += drop;
        this.tail = this.tail.slice(drop);
      }
    }
  }
  render(logRef: string): string {
    if (!this.cut) return this.head + this.tail;
    return `${this.head}\n[... ${this.cut} characters cut; the full output is in ${logRef} ...]\n${this.tail}`;
  }
}

/** One printed value over the 32 KiB echo cap keeps its head and tail. */
export function capEcho(s: string, logRef: string): string {
  if (s.length <= LIMITS.echoBytes) return s;
  const half = LIMITS.echoBytes / 2;
  return `${s.slice(0, half)}\n[... ${s.length - LIMITS.echoBytes} characters cut from this value (32 KiB per value); full output in ${logRef} ...]\n${s.slice(-half)}`;
}

class Semaphore {
  private waiters: (() => void)[] = [];
  private used = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.used < this.max) { this.used++; return; }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.used--;
  }
}

export interface ScriptRunOptions {
  jobId: string;
  runId: string;
  /** Id of the outer Script tool call; names the per-run log file. */
  outerId: string;
  sessionId: string;
  parsed: ParsedScript;
  toolNames: string[];
  host: ScriptHost;
  resultLog: ResultLog;
  limits?: Partial<SandboxLimits>;
}

export class ScriptRun implements Job {
  readonly kind = "script" as const;
  readonly title: string;
  status: JobStatus = "running";
  reported = false;
  detached = false;
  readonly done: Promise<void>;
  readonly logRef: string;
  toolCalls = 0;
  /** Images the program passed to image(base64, mime); the model sees them with the result. */
  readonly images: { type: "image"; mediaType: string; data: string }[] = [];
  private errors: { call: number; tool: string; message: string }[] = [];
  private scriptError?: string;
  private printed = new PrintBuffer();
  private events = 0;
  private outBytes = 0;
  private droppedEvents = 0;
  private sandbox: Sandbox;
  private sem = new Semaphore(LIMITS.maxInflight);
  private ac = new AbortController();
  private stopped = false;
  private startedAt = Date.now();
  readonly id: string;
  readonly runId: string;

  constructor(private o: ScriptRunOptions) {
    this.id = o.jobId;
    this.runId = o.runId;
    this.title = o.parsed.code.trim().split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.slice(0, 80) ?? "Script";
    const dir = scriptsDir(o.sessionId);
    this.logRef = path.join(dir, `${o.outerId}.log`);
    writeFileSync(this.logRef, "");
    this.sandbox = new Sandbox({
      onCall: (id, name, input) => void this.handleCall(id, name, input),
      onPrint: (t) => this.emitPrint(t),
      onImage: (d, mime) => this.addImage(d, mime),
      onNotify: (t) => this.event(() => this.o.host.notify(t)),
    }, { ...DEFAULT_LIMITS, ...o.limits });
    this.done = this.sandbox.finished.then((r) => this.finalize(r));
  }

  start(): void {
    this.sandbox.start(this.o.parsed.code, this.o.parsed.inputs, this.o.toolNames);
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    this.sandbox.kill();
  }

  private finalize(r: { ok: boolean; error?: { name?: string; message?: string; stack?: string }; timedOut?: boolean }): void {
    if (r.ok) this.status = "completed";
    else {
      this.status = r.timedOut ? "timed_out" : "failed";
      const e = r.error;
      this.scriptError = this.stopped ? "The Script was stopped." : `${e?.name ?? "Error"}: ${e?.message ?? "unknown error"}${e?.stack ? `\n${e.stack.trimEnd()}` : ""}`;
    }
    // Abort inner calls still in flight so nothing keeps running for a finished Script.
    if (!r.ok) this.ac.abort();
    this.logLine(`--- ${this.status}; ${this.toolCalls} tool calls; ${Date.now() - this.startedAt} ms${this.scriptError ? `\n${this.scriptError}` : ""}`);
  }

  private addImage(data: string, mime: string): void {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return this.emitPrint(`[image not shown: ${mime} is not PNG, JPEG, GIF or WebP]`);
    if (this.images.length >= 8) return this.emitPrint("[image not shown: at most 8 images per run]");
    if (data.length > 7 * 1024 * 1024) return this.emitPrint("[image not shown: over 5 MiB]");
    this.images.push({ type: "image", mediaType: mime, data });
    this.emitPrint(`[image ${this.images.length} attached (${mime})]`);
  }

  private logLine(s: string): void {
    try { appendFileSync(this.logRef, s + "\n"); } catch { /* log is best effort */ }
  }

  /** Counts one output event against the 1,024 cap. */
  private event(f: () => void): void {
    if (this.events >= LIMITS.events) { this.droppedEvents++; return; }
    this.events++;
    f();
  }

  private emitPrint(text: string): void {
    this.event(() => {
      const bytes = Buffer.byteLength(text);
      if (this.outBytes >= LIMITS.outputBytes) { this.droppedEvents++; return; }
      this.outBytes += bytes;
      this.logLine(text);
      this.printed.push(capEcho(text, this.logRef) + "\n");
    });
  }

  report(): Record<string, unknown> {
    let output = this.printed.render(this.logRef);
    if (this.droppedEvents) output += `\n[${this.droppedEvents} output events were dropped: over the ${LIMITS.events}-event or 5 MiB output cap]`;
    if (this.scriptError) output += `${output && !output.endsWith("\n") ? "\n" : ""}Script error: ${this.scriptError}`;
    const r: Record<string, unknown> = {
      status: this.status, job_id: this.id, output,
      tool_calls: this.toolCalls,
      errors: this.errors.slice(0, LIMITS.errorsShown),
      log_ref: this.logRef,
    };
    if (this.errors.length > LIMITS.errorsShown) r.more_errors = this.errors.length - LIMITS.errorsShown;
    return r;
  }

  private async handleCall(id: number, name: string, inputText: string): Promise<void> {
    const reply = (payload: unknown) => this.sandbox.reply(id, payload);
    if (name === "__results_search" || name === "__results_get") {
      try {
        const a = JSON.parse(inputText);
        if (name === "__results_search") {
          return reply({ ok: true, value: this.o.resultLog.search(String(a.query ?? ""), a.opts ?? {}) });
        }
        const e = this.o.resultLog.get(String(a.job_id), Number(a.call));
        if (!e) return reply({ ok: false, error: { name: "NotFound", message: `No logged result for job ${a.job_id} call ${a.call}. Plain Read results are not logged; read the file again.` } });
        return reply({ ok: true, value: e.result });
      } catch (e) {
        return reply({ ok: false, error: { name: "Error", message: String((e as Error).message) } });
      }
    }
    const n = ++this.toolCalls;
    let input: Record<string, unknown>;
    try {
      const v = JSON.parse(inputText);
      input = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      input = {};
    }
    await this.sem.acquire();
    try {
      if (this.ac.signal.aborted) throw new ToolCallError("The Script was stopped before this call ran.", "Aborted");
      const out = await this.o.host.callTool(name, input, { runId: this.runId, n, outerId: this.o.outerId, signal: this.ac.signal, foreground: !this.detached });
      if (Buffer.byteLength(out.content) > LIMITS.resultBytes) {
        throw new ToolCallError(`The result of this ${name} call is over 5 MiB and was rejected. Narrow the call (offset and limit, a tighter pattern).`);
      }
      const value = structure(name, input, out, this.o.host.cwd);
      if (name !== "Read") this.o.resultLog.append({ job_id: this.id, call: n, tool: name, input, isError: false, result: value, at: new Date().toISOString() });
      this.logLine(`#${n} ${name} ok`);
      reply({ ok: true, value });
    } catch (e) {
      const err = e as Error;
      const eName = e instanceof ToolCallError ? e.errorName : "Error";
      this.errors.push({ call: n, tool: name, message: err.message });
      if (name !== "Read") this.o.resultLog.append({ job_id: this.id, call: n, tool: name, input, isError: true, result: err.message, at: new Date().toISOString() });
      this.logLine(`#${n} ${name} error: ${err.message}`);
      reply({ ok: false, error: { name: eName, message: err.message } });
    } finally {
      this.sem.release();
    }
  }
}

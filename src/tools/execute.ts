import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { fail, intArg, ok, promptDesc, promptSchema, resolvePath, strArg } from "./util.ts";

export const EXECUTE_OUTPUT_CAP = 30_000;
export const EXECUTE_DEFAULT_TIMEOUT_MS = 120_000;
export const EXECUTE_MAX_TIMEOUT_MS = 600_000;

let shellCache: { path: string; name: string } | undefined;
export function resolveShell(): { path: string; name: string } {
  if (!shellCache) {
    const bash = Bun.which("bash");
    shellCache = bash ? { path: bash, name: "bash" } : { path: Bun.which("sh") ?? "/bin/sh", name: "/bin/sh" };
  }
  return shellCache;
}

/** Keeps the head and tail of a stream, dropping the middle once over the cap. */
export class CappedText {
  private head = "";
  private tail = "";
  total = 0;
  constructor(private cap: number) {}
  push(s: string): void {
    this.total += s.length;
    const half = Math.floor(this.cap / 2);
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) {
      this.tail += s;
      if (this.tail.length > half) this.tail = this.tail.slice(this.tail.length - half);
    }
  }
  toString(): string {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return this.head + this.tail;
    return `${this.head}\n[... ${this.total - kept} characters cut ...]\n${this.tail}`;
  }
}

/** Strips the risk paragraphs from the description when risk is not asked for. */
function withoutRisk(desc: string): string {
  const lines = desc.split("\n");
  const start = lines.findIndex((l) => l.startsWith("riskLevel (required)"));
  const end = lines.findIndex((l) => l.startsWith("riskReason (required)"));
  if (start === -1 || end === -1) return desc;
  lines.splice(start, end - start + 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function createExecuteTool(opts: { skipPermissions?: boolean } = {}): Tool {
  const shell = resolveShell();
  let description = promptDesc("Execute", {
    SHELL: shell.name,
    EXECUTE_OUTPUT_CAP: "30,000 characters",
  });
  const inputSchema = promptSchema("Execute");
  if (opts.skipPermissions) {
    delete inputSchema.properties.riskLevel;
    delete inputSchema.properties.riskReason;
    inputSchema.required = (inputSchema.required as string[]).filter((k) => k !== "riskLevel" && k !== "riskReason");
    description = withoutRisk(description);
  }
  return {
    name: "Execute",
    description,
    inputSchema,
    category: "execute",
    run: (input, ctx) => runExecute(input, ctx),
  };
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

async function runExecute(input: Record<string, unknown>, ctx: ToolContext, background = false): Promise<ToolOutput> {
  const command = strArg(input, "command");
  if (!command || !command.trim()) return fail("command is required.");
  const cwdIn = strArg(input, "cwd");
  const cwd = cwdIn ? resolvePath(cwdIn, ctx.cwd) : ctx.cwd;
  try {
    if (!fs.statSync(cwd).isDirectory()) return fail(`cwd ${cwd} is not a directory.`);
  } catch {
    return fail(`cwd ${cwd} does not exist.`);
  }
  if (input.background === true && !background) {
    if (!ctx.jobs) return fail("Background execution is not available here; run the command in the foreground.");
    const jobs = ctx.jobs;
    const foreground = { ...input, background: false };
    const jobId = jobs.startBackground({
      kind: "execute",
      title: command.length > 80 ? `${command.slice(0, 80)}...` : command,
      run: (signal) => runExecute(foreground, { ...ctx, signal, jobs: undefined, onProgress: undefined }, true),
    });
    return ok(JSON.stringify({ status: "running", job_id: jobId, note: "You will be woken with the result when it exits. Check or stop it with script_job." }));
  }
  // A background command has no default time limit; it runs until it exits or is stopped.
  const requested = intArg(input, "timeoutMs");
  const timeoutMs = background && requested === undefined
    ? 0
    : Math.min(EXECUTE_MAX_TIMEOUT_MS, Math.max(1, requested ?? EXECUTE_DEFAULT_TIMEOUT_MS));
  if (ctx.signal.aborted) return fail("Command was cancelled before it started.");

  const shell = resolveShell();
  const started = Date.now();
  const out = new CappedText(EXECUTE_OUTPUT_CAP);
  const err = new CappedText(EXECUTE_OUTPUT_CAP);
  const both = new CappedText(EXECUTE_OUTPUT_CAP);

  return await new Promise<ToolOutput>((resolve) => {
    const child = spawn(shell.path, ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: process.env.CI ?? "1", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const dec = { o: new StringDecoder("utf8"), e: new StringDecoder("utf8") };

    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      out.push(dec.o.end());
      err.push(dec.e.end());
      ctx.onProgress?.({ type: "status", exitCode, signal, fullOutput: both.toString() });
      const durationMs = Date.now() - started;
      const parts: string[] = [];
      if (spawnError) parts.push(`Failed to start the shell: ${spawnError}`);
      if (timedOut) parts.push(`Timed out after ${timeoutMs} ms; the command was killed.`);
      else if (aborted) parts.push("The command was cancelled and killed.");
      parts.push(`exit code: ${exitCode ?? "none"}${signal ? ` (signal ${signal})` : ""}; duration ${durationMs} ms`);
      const so = out.toString();
      const se = err.toString();
      parts.push(`--- stdout ---\n${so === "" ? "(empty)" : so}`);
      parts.push(`--- stderr ---\n${se === "" ? "(empty)" : se}`);
      const ran = !timedOut && !aborted && !spawnError;
      resolve({
        content: parts.join("\n"),
        isError: exitCode !== 0 || timedOut || aborted || !!spawnError,
        ...(ran ? { data: { exitCode, stdout: so, stderr: se, durationMs, truncated: out.total > EXECUTE_OUTPUT_CAP || err.total > EXECUTE_OUTPUT_CAP } } : {}),
      });
    };

    const onAbort = () => {
      aborted = true;
      killGroup(child.pid, "SIGKILL");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGKILL");
      }, timeoutMs)
      : undefined;

    child.stdout!.on("data", (b: Buffer) => {
      const t = dec.o.write(b);
      if (!t) return;
      out.push(t);
      both.push(t);
      ctx.onProgress?.({ type: "status", text: t, fullOutput: both.toString() });
    });
    child.stderr!.on("data", (b: Buffer) => {
      const t = dec.e.write(b);
      if (!t) return;
      err.push(t);
      both.push(t);
      ctx.onProgress?.({ type: "status", text: t, fullOutput: both.toString() });
    });
    child.on("error", (e) => finish(null, null, e.message));
    child.on("exit", (code, signal) => {
      // Pipes may stay open if a background child inherited them; do not wait forever.
      const grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 300);
      child.on("close", () => {
        clearTimeout(grace);
        finish(code, signal);
      });
    });
  });
}

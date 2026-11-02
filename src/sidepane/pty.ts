// Terminals hosted by the daemon (spec §17.2). A PTY outlives the connection that created it: when the owner drops,
// a grace timer starts; a client that reattaches (list_terminals with the same session id) adopts it and gets the
// scrollback back so the view can repaint. Otherwise the terminal is killed when the timer fires.
//
// Mechanism: Bun's built-in pseudo terminal support (`Bun.spawn(cmd, { terminal })`), so no native module is needed.
// Windows: Bun's terminal option is POSIX only, and a ConPTY binding would need a native module. There the shell is
// started with plain pipes ("pipe mode"): output streams, input works, exit codes are reported, and the terminal keeps
// its scrollback and survives a dropped connection like any other. Limits: no terminal emulation for the child (full
// screen programs and line editing do not work, the shell does not echo typed text) and resize only records the size.
// Scrollback is the raw output kept as a capped string (default 1 MB) instead of a headless xterm; the renderer
// writes it into xterm.js, which repaints exactly what the shell drew. `plainText` strips escape sequences for
// clients that only want text (search, accessibility, tests).
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";

export const SHELL_ALLOW = ["bash", "sh", "zsh", "dash", "cmd.exe", "powershell.exe", "pwsh.exe"];
const UNIX_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
export const PROTECTED_ENV = [
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
  "SUDO_USER", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO",
];

/** Something that can receive terminal notifications: one client connection. */
export interface TerminalOwner {
  id: string;
  notify(n: Record<string, unknown>): void;
}

export interface TerminalOptions {
  /** Time an orphaned terminal lives before it is killed. Default 30 s. */
  graceMs?: number;
  /** Sweep for unowned terminals. Default 30 min. */
  sweepMs?: number;
  /** Max bytes of scrollback kept per terminal (as UTF-16 chars). Default 1,000,000. */
  scrollbackChars?: number;
  log?: (m: string) => void;
}

interface Term {
  id: string;
  sessionId: string;
  pid: number;
  cols: number;
  rows: number;
  createdAt: number;
  owner?: TerminalOwner;
  scrollback: string;
  cursorHidden: boolean;
  proc: any;
  /** Terminal I/O: a PTY where Bun supports it, plain pipes on Windows. */
  io: { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
  grace?: ReturnType<typeof setTimeout>;
  orphanSince?: number;
  closing: boolean;
}

/** Picks the shell: only allow-listed names are honored; anything else becomes the platform default. */
export function resolveShell(requested?: string, platform: NodeJS.Platform = process.platform): string {
  const name = requested ? basename(requested.replace(/\\/g, "/")) : "";
  const fallback = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "zsh" : "bash";
  // Windows compares the file name only (case-insensitive); elsewhere the shell must sit in a system folder or be a bare name.
  const allowed = platform === "win32"
    ? SHELL_ALLOW.some((a) => a.toLowerCase() === name.toLowerCase())
    : SHELL_ALLOW.includes(name) && (UNIX_DIRS.some((d) => requested!.startsWith(d + "/")) || !requested!.includes("/"));
  const pick = allowed ? (platform === "win32" ? name.toLowerCase() : name) : fallback;
  if (platform === "win32") return pick;
  for (const d of UNIX_DIRS) if (existsSync(`${d}/${pick}`)) return `${d}/${pick}`;
  return Bun.which(pick) ?? Bun.which("sh") ?? "/bin/sh";
}

/** Env for the shell: the daemon's environment plus the caller's, minus protected keys the caller cannot set. */
export function buildEnv(base: Record<string, string | undefined>, caller?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") out[k] = v;
  for (const [k, v] of Object.entries(caller ?? {})) {
    if (typeof v !== "string" || PROTECTED_ENV.includes(k)) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  return out;
}

// Escape sequences: CSI, OSC (BEL or ST terminated), and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n").replace(/\r/g, "");

export class TerminalManager {
  private terms = new Map<string, Term>();
  private sweep?: ReturnType<typeof setInterval>;
  private grace: number;
  private cap: number;

  constructor(private opts: TerminalOptions = {}) {
    this.grace = opts.graceMs ?? 30_000;
    this.cap = opts.scrollbackChars ?? 1_000_000;
    this.sweep = setInterval(() => this.sweepOrphans(), opts.sweepMs ?? 30 * 60_000);
    (this.sweep as any).unref?.();
  }

  private key(sessionId: string, terminalId: string) { return `${sessionId}\u0000${terminalId}`; }

  get count() { return this.terms.size; }

  create(owner: TerminalOwner, p: { sessionId: string; terminalId: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, unknown>; shell?: string; defaultCwd: string }) {
    const k = this.key(p.sessionId, p.terminalId);
    if (this.terms.has(k)) return { success: false as const, error: "TerminalIdExists" };
    const cwd = p.cwd ?? p.defaultCwd;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `cwd does not exist: ${cwd}`, { reason: "not_found" });
    }
    const cols = Math.max(2, Math.floor(p.cols ?? 80));
    const rows = Math.max(1, Math.floor(p.rows ?? 24));
    const shell = resolveShell(p.shell);
    const term: Term = { id: p.terminalId, sessionId: p.sessionId, pid: 0, cols, rows, createdAt: Date.now(), owner, scrollback: "", cursorHidden: false, proc: undefined, io: { write() {}, resize() {}, close() {} }, closing: false };
    const decoder = new TextDecoder();
    let proc: any;
    if (process.platform === "win32") {
      proc = (Bun as any).spawn([shell], { cwd, env: buildEnv(process.env, p.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
        const dec = new TextDecoder();
        void (async () => {
          try { for await (const chunk of stream as any) this.onData(term, dec.decode(chunk, { stream: true })); } catch { /* closed */ }
        })();
      }
      term.io = {
        write: (data) => { try { proc.stdin.write(data); proc.stdin.flush?.(); } catch { /* shell is gone */ } },
        resize: () => { /* no PTY: the size is only recorded */ },
        close: () => { try { proc.stdin.end(); } catch { /* ignore */ } },
      };
    } else {
      proc = (Bun as any).spawn([shell], {
        cwd, env: buildEnv(process.env, p.env),
        terminal: {
          cols, rows,
          data: (_t: unknown, chunk: Uint8Array) => this.onData(term, decoder.decode(chunk, { stream: true })),
        },
      });
      term.io = { write: (d) => proc.terminal.write(d), resize: (c, r) => proc.terminal.resize(c, r), close: () => proc.terminal?.close?.() };
    }
    term.proc = proc;
    term.pid = proc.pid;
    this.terms.set(k, term);
    void proc.exited.then((code: number) => this.onExit(k, term, code ?? 0));
    return { success: true as const };
  }

  private onData(t: Term, text: string) {
    t.scrollback += text;
    if (t.scrollback.length > this.cap) {
      const cut = t.scrollback.length - this.cap;
      const nl = t.scrollback.indexOf("\n", cut);
      t.scrollback = t.scrollback.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut);
    }
    const hide = t.scrollback.lastIndexOf("\u001b[?25l"), show = t.scrollback.lastIndexOf("\u001b[?25h");
    t.cursorHidden = hide > show;
    t.owner?.notify({ type: "daemon.terminal_data", terminalId: t.id, data: text });
  }

  private onExit(k: string, t: Term, code: number) {
    if (this.terms.get(k) !== t) return;
    clearTimeout(t.grace);
    this.terms.delete(k);
    const signal = t.proc?.signalCode ?? null;
    t.owner?.notify({ type: "daemon.terminal_exit", terminalId: t.id, exitCode: code, signal });
  }

  private owned(owner: TerminalOwner, sessionId: string, terminalId: string): Term {
    const t = this.terms.get(this.key(sessionId, terminalId));
    if (!t) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `Terminal not found: ${terminalId}`);
    if (t.owner?.id !== owner.id) throw new RpcError(ErrorCodes.CONFLICT, "Terminal is owned by another connection; list terminals to adopt it", { reason: "not_owner" });
    return t;
  }

  write(owner: TerminalOwner, sessionId: string, terminalId: string, data: string) {
    this.owned(owner, sessionId, terminalId).io.write(data);
    return { success: true };
  }

  resize(owner: TerminalOwner, sessionId: string, terminalId: string, cols: number, rows: number) {
    const t = this.owned(owner, sessionId, terminalId);
    t.cols = Math.max(2, Math.floor(cols)); t.rows = Math.max(1, Math.floor(rows));
    t.io.resize(t.cols, t.rows);
    return { success: true };
  }

  close(owner: TerminalOwner, sessionId: string, terminalId: string) {
    const t = this.owned(owner, sessionId, terminalId);
    this.kill(t);
    return { success: true };
  }

  private kill(t: Term) {
    t.closing = true;
    try { t.proc.kill(); } catch {}
    try { t.io.close(); } catch {}
  }

  /** Terminals of a session. Unowned ones (their connection dropped) are adopted by `owner`, which cancels the grace timer. */
  list(owner: TerminalOwner, sessionId: string) {
    const out = [];
    for (const t of this.terms.values()) {
      if (t.sessionId !== sessionId) continue;
      if (!t.owner || t.owner.id !== owner.id) {
        if (t.owner) continue; // owned by a live connection (another window): not adoptable
        t.owner = owner;
        clearTimeout(t.grace);
        t.grace = undefined;
        t.orphanSince = undefined;
      }
      out.push({
        id: t.id, pid: t.pid, cols: t.cols, rows: t.rows, createdAt: t.createdAt,
        state: { serialized: t.scrollback, plainText: stripAnsi(t.scrollback), cols: t.cols, rows: t.rows, timestamp: Date.now(), ...(t.cursorHidden ? { cursorHidden: true } : {}) },
      });
    }
    return { terminals: out };
  }

  /** A connection dropped: its terminals get a grace period before they are killed. */
  release(owner: TerminalOwner) {
    for (const t of this.terms.values()) {
      if (t.owner?.id !== owner.id) continue;
      t.owner = undefined;
      t.orphanSince = Date.now();
      clearTimeout(t.grace);
      t.grace = setTimeout(() => { if (!t.owner) { this.opts.log?.(`[terminal] ${t.id} orphaned, killing`); this.kill(t); } }, this.grace);
      (t.grace as any).unref?.();
    }
  }

  private sweepOrphans() {
    for (const t of this.terms.values()) if (!t.owner && !t.grace) this.kill(t);
  }

  /** Daemon shutdown: close everything. */
  closeAll() {
    clearInterval(this.sweep);
    for (const t of [...this.terms.values()]) { clearTimeout(t.grace); this.kill(t); }
  }
}

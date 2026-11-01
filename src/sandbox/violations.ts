// Sandbox violation vocabulary (spec 5.5.1): type filesystem-read | filesystem-write | network | tool,
// reason deny-list | not-allowed. Detection: stderr of the command (EROFS / EACCES on a path outside the
// writable set) plus a pre-check of the command text for credential / denied read paths.
import * as path from "node:path";
import { contains, type SandboxPolicy } from "./policy.ts";

export type ViolationType = "filesystem-read" | "filesystem-write" | "network" | "tool";
export type ViolationReason = "deny-list" | "not-allowed";

export interface SandboxViolation {
  type: ViolationType;
  reason: ViolationReason;
  /** Path or host. */
  target: string;
  command: string;
  at: number;
}

export const MAX_VIOLATIONS = 500;

/** Bounded per-session log: the newest 500 are kept. */
export class ViolationLog {
  private items: SandboxViolation[] = [];
  push(v: SandboxViolation): void {
    this.items.push(v);
    if (this.items.length > MAX_VIOLATIONS) this.items.splice(0, this.items.length - MAX_VIOLATIONS);
  }
  list(): SandboxViolation[] {
    return [...this.items];
  }
  get size(): number {
    return this.items.length;
  }
}

const ERR_LINE = /(Read-only file system|Permission denied|Operation not permitted)/i;
const CANDIDATE = /'([^']+)'|"([^"]+)"|(?:^|[\s:(])((?:\.{0,2}\/)[^\s:'")]+)/g;

function lastPathIn(line: string, cwd: string): string | undefined {
  let last: string | undefined;
  for (const m of line.matchAll(CANDIDATE)) {
    const c = m[1] ?? m[2] ?? m[3];
    if (c && (c.startsWith("/") || c.startsWith("./") || c.startsWith("../") || /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(c))) last = c;
  }
  return last ? path.resolve(cwd, last) : undefined;
}

/** Violations visible in a command's stderr. Only paths the sandbox is responsible for are reported. */
export function detectFromStderr(stderr: string, policy: SandboxPolicy, cwd: string, command: string, now = Date.now()): SandboxViolation[] {
  const out: SandboxViolation[] = [];
  const seen = new Set<string>();
  for (const line of stderr.split("\n")) {
    const m = line.match(ERR_LINE);
    if (!m) continue;
    const target = lastPathIn(line, cwd);
    if (!target) continue;
    const inReadOnly = policy.readOnly.some((r) => contains(r, target));
    const inWritable = policy.writable.some((w) => contains(w, target));
    const erofs = /Read-only/i.test(m[1]!);
    // EACCES/EPERM inside the writable set is an ordinary file permission, not the sandbox.
    if (!erofs && inWritable && !inReadOnly) continue;
    if (target.startsWith("/proc/") || target.startsWith("/dev/")) continue;
    const key = `w:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "filesystem-write", reason: inReadOnly ? "deny-list" : "not-allowed", target, command, at: now });
  }
  return out;
}

/** Reads of denied paths cannot fail with EACCES inside the sandbox (they come back empty or missing),
 * so the command text is checked for mentions of denied paths. */
export function detectDeniedReads(command: string, policy: SandboxPolicy, home: string, now = Date.now()): SandboxViolation[] {
  const out: SandboxViolation[] = [];
  for (const u of policy.unreadable) {
    const rel = contains(home, u) && u !== home ? path.relative(home, u) : undefined;
    const forms = [u, ...(rel ? [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`] : [])];
    for (const f of forms) {
      const i = command.indexOf(f);
      if (i === -1) continue;
      const next = command[i + f.length];
      if (next !== undefined && /[\w.-]/.test(next)) continue; // a longer name, e.g. ~/.sshx
      out.push({ type: "filesystem-read", reason: "deny-list", target: u, command, at: now });
      break;
    }
  }
  return out;
}

/** Combined view of ways to describe a violation for the model. */
export function describeViolation(v: SandboxViolation): string {
  const what = v.type === "filesystem-write" ? "write to" : v.type === "filesystem-read" ? "read of" : v.type === "network" ? "network access to" : "use of";
  return `${what} ${v.target} (${v.reason})`;
}

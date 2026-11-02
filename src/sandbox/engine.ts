// Sandbox engines (spec 5.5.8): bubblewrap on Linux, sandbox-exec on macOS, none on Windows.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { contains, type SandboxPolicy } from "./policy.ts";

export type EngineName = "bubblewrap" | "sandbox-exec" | "none";

export interface EngineInfo {
  engine: EngineName;
  available: boolean;
  /** Why it is not available (shown in status). */
  reason?: string;
  /** Path to the engine binary. */
  bin?: string;
  /** True when a filtering proxy can be bridged into the sandbox (Linux needs socat). */
  canProxy: boolean;
  socat?: string;
}

export interface EngineProbe {
  platform?: NodeJS.Platform;
  which?: (cmd: string) => string | null | undefined;
  /** Returns an error message when the bubblewrap binary cannot create a sandbox here. */
  probeBwrap?: (bwrap: string) => string | undefined;
}

function defaultProbeBwrap(bwrap: string): string | undefined {
  const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { encoding: "utf8", timeout: 5000 });
  if (r.error) return r.error.message;
  if (r.status !== 0) return (r.stderr || `exit ${r.status}`).trim().split("\n")[0];
  return undefined;
}

let cache: EngineInfo | undefined;

/** Which engine can run on this machine. Cached for the default probe. */
export function detectEngine(p: EngineProbe = {}): EngineInfo {
  const custom = p.platform !== undefined || p.which !== undefined || p.probeBwrap !== undefined;
  if (!custom && cache) return cache;
  const platform = p.platform ?? process.platform;
  const which = p.which ?? ((c: string) => Bun.which(c));
  let info: EngineInfo;
  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (!bwrap) info = { engine: "bubblewrap", available: false, reason: "bubblewrap (bwrap) is not installed", canProxy: false };
    else {
      const err = (p.probeBwrap ?? defaultProbeBwrap)(bwrap);
      const socat = which("socat") ?? undefined;
      info = err
        ? { engine: "bubblewrap", available: false, reason: `bubblewrap cannot create a sandbox here: ${err}`, bin: bwrap, canProxy: false }
        : { engine: "bubblewrap", available: true, bin: bwrap, canProxy: !!socat, ...(socat ? { socat } : {}) };
    }
  } else if (platform === "darwin") {
    const se = which("sandbox-exec") ?? (fs.existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : undefined);
    info = se
      ? { engine: "sandbox-exec", available: true, bin: se, canProxy: true }
      : { engine: "sandbox-exec", available: false, reason: "sandbox-exec was not found", canProxy: false };
  } else {
    info = { engine: "none", available: false, reason: `the sandbox is not supported on ${platform}`, canProxy: false };
  }
  if (!custom) cache = info;
  return info;
}

export const PROXY_INNER_PORT = 3128;

export interface BwrapOptions {
  policy: SandboxPolicy;
  /** Unix socket of the host proxy (rule "proxy"). */
  proxySocket?: string;
  socat?: string;
  env?: Record<string, string>;
  /** File descriptor number bubblewrap reads a compiled seccomp program from (the caller must open it: see bwrapExec). */
  seccompFd?: number;
  /** Path of the compiled seccomp program; bwrapCommand opens it as fd 9 (a sh redirect) and adds --seccomp 9. */
  seccompFile?: string;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p: string) => fs.existsSync(p);

/** bwrap arguments (without the command). Mount order matters: later mounts overlay earlier ones. */
export function buildBwrapArgs(o: BwrapOptions): string[] {
  const { policy } = o;
  const a: string[] = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const w of policy.writable) if (exists(w)) a.push("--bind", w, w);
  for (const r of policy.readOnly) {
    if (!exists(r) || !policy.writable.some((w) => contains(w, r))) continue;
    a.push("--ro-bind", r, r);
  }
  for (const u of policy.unreadable) {
    if (!exists(u)) continue;
    if (isDir(u)) a.push("--tmpfs", u);
    else a.push("--ro-bind", "/dev/null", u);
  }
  for (const r of policy.readAllowed) {
    if (exists(r) && policy.unreadable.some((u) => contains(u, r) && isDir(u))) a.push("--ro-bind", r, r);
  }
  if (policy.network.rule !== "all") a.push("--unshare-net");
  if (o.proxySocket) a.push("--bind", o.proxySocket, o.proxySocket);
  for (const [k, v] of Object.entries(o.env ?? {})) a.push("--setenv", k, v);
  if (o.seccompFd !== undefined) a.push("--seccomp", String(o.seccompFd));
  return a;
}

/** The seccomp program is handed to bubblewrap as fd 9, opened by a one-line sh wrapper (no change to how callers spawn). */
export const SECCOMP_FD = 9;

/** Runs `cmd` under bubblewrap with `base` arguments (from buildBwrapArgs; include seccompFd: SECCOMP_FD when seccompFile is given). */
export function bwrapExec(
  bwrap: string, base: string[], cmd: string[], o: { proxySocket?: string; socat?: string; seccompFile?: string } = {},
): { file: string; args: string[] } {
  let inner: string[];
  if (o.proxySocket && o.socat) {
    const port = PROXY_INNER_PORT;
    const script =
      `${o.socat} TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${o.proxySocket} >/dev/null 2>&1 & ` +
      `i=0; while [ $i -lt 100 ] && ! ${o.socat} -u /dev/null TCP:127.0.0.1:${port} 2>/dev/null; do sleep 0.02; i=$((i+1)); done; ` +
      `exec "$@"`;
    inner = ["/bin/sh", "-c", script, "sh", ...cmd];
  } else inner = cmd;
  const line = [bwrap, ...base, "--", ...inner];
  if (!o.seccompFile) return { file: line[0]!, args: line.slice(1) };
  return { file: "/bin/sh", args: ["-c", `exec ${SECCOMP_FD}<"$1" || exit 126; shift; exec "$@"`, "sh", o.seccompFile, ...line] };
}

/** Wraps the shell invocation: inside a proxy sandbox a socat bridge runs from loopback to the host proxy socket. */
export function bwrapCommand(bwrap: string, o: BwrapOptions, shell: string, command: string): { file: string; args: string[] } {
  const base = buildBwrapArgs({ ...o, seccompFd: o.seccompFile ? SECCOMP_FD : o.seccompFd });
  return bwrapExec(bwrap, base, [shell, "-c", command], { proxySocket: o.proxySocket, socat: o.socat, seccompFile: o.seccompFile });
}

/** Environment that points proxy-aware programs at the in-sandbox proxy listener. */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: "", no_proxy: "" };
}

const sbQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** macOS seatbelt profile. Writes are denied except under writable paths; credential reads denied; network denied except the local proxy. */
export function buildSeatbeltProfile(policy: SandboxPolicy, proxyPort?: number): string {
  const L: string[] = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const wr = [...policy.writable, "/dev/null", "/dev/tty", "/dev/dtracehelper", "/private/tmp", "/private/var/folders", "/tmp"];
  L.push(`(allow file-write* ${wr.map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`);
  if (policy.readOnly.length) L.push(`(deny file-write* ${policy.readOnly.map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`);
  if (policy.unreadable.length) L.push(`(deny file-read* ${policy.unreadable.map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`);
  if (policy.readAllowed.length) L.push(`(allow file-read* ${policy.readAllowed.map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`);
  if (policy.network.rule !== "all") {
    L.push("(deny network*)");
    if (policy.network.rule === "proxy" && proxyPort) L.push(`(allow network-outbound (remote ip "localhost:${proxyPort}"))`);
    if (policy.network.allowLocalBinding) L.push('(allow network-bind (local ip "localhost:*"))');
  }
  return L.join("\n") + "\n";
}

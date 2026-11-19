import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineSplitter, toLine, type Transport } from "../sdk/transport.ts";
import { machineDefinition, type Machine } from "./store.ts";

export const shellQuote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
export const windowsArgument = (text: string) => '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export function remoteCommand(machine: Machine, args: string[]): string {
  if (!machine.platform) throw new Error("Bootstrap the machine before opening a session");
  if (args.some((s) => /[\0\r\n]/.test(s))) throw new Error("Invalid remote command argument");
  if (machine.platform !== "win32") return args.map(shellQuote).join(" ");
  const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  if (!args.length) throw new Error("Remote command is empty");
  // PowerShell's native-command job waits for descendant processes, including the daemon
  // deliberately detached by bootstrap. Wait only for the launcher and drain its pipes.
  // Inherit the SSH input handle directly, preserving streaming protocol traffic and EOF.
  const script = `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::new();$p.StartInfo.FileName=${literal(args[0]!)};$p.StartInfo.Arguments=${literal(args.slice(1).map(windowsArgument).join(" "))};$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$null=$p.Start();$o=$p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$e=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());$p.WaitForExit();$null=$o.GetAwaiter().GetResult();$null=$e.GetAwaiter().GetResult();$code=$p.ExitCode;$p.Dispose();exit $code`;
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
export function sshArgs(input: Machine): string[] {
  const m = machineDefinition(input);
  const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  if (m.port) args.push("-p", String(m.port));
  if (m.identityFile) args.push("-i", m.identityFile, "-o", "IdentitiesOnly=yes");
  if (m.knownHostsFile) args.push("-o", `UserKnownHostsFile="${m.knownHostsFile.replace(/\\/g, "/").replace(/"/g, '\\"')}"`);
  return args;
}

/** OpenSSH SFTP uses the machine's existing identity and pinned host. */
export async function uploadSftp(input: Machine, bytes: Uint8Array, remote: string): Promise<void> {
  const machine = machineDefinition(input);
  // ssh's -T is unrelated to scp's -T, which relaxes filename checking.
  const args = sshArgs(machine).slice(1).map((arg) => arg === "-p" ? "-P" : arg);
  const dir = mkdtempSync(join(tmpdir(), "rigwell-remote-upload-"));
  const local = join(dir, "build.tar");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Bun.write(local, bytes);
    const result = Bun.spawn(["scp", "-qs", ...args, "-o", "ClearAllForwardings=yes", local, `${machine.host}:${remote.replaceAll("\\", "/")}`], {
      stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true,
    });
    timer = setTimeout(() => result.kill("SIGKILL"), 120_000);
    const [code, error] = await Promise.all([result.exited, new Response(result.stderr).text()]);
    if (code !== 0) throw new Error(`Remote archive upload failed (${code}): ${error.trim().slice(-8000)}`);
  } finally {
    clearTimeout(timer);
    rmSync(local, { force: true });
    rmdirSync(dir);
  }
}

/** An SSH channel carries protocol lines in both directions, including user permission requests. */
export class SshTransport implements Transport {
  onMessage: Transport["onMessage"] = () => {};
  onClose: Transport["onClose"] = () => {};
  readonly process: ChildProcess;
  private ended = false;
  private exited: Promise<void>;
  constructor(machine: Machine, command: string, opts: { executable?: string[]; onStderr?: (text: string) => void } = {}) {
    const base = opts.executable ?? ["ssh"];
    this.process = spawn(base[0]!, [...base.slice(1), ...sshArgs(machine), "-o", "ClearAllForwardings=yes", machine.host, command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const split = new LineSplitter((line) => this.onMessage(line));
    this.process.stdout!.setEncoding("utf8").on("data", (text: string) => split.push(text));
    this.process.stderr!.setEncoding("utf8").on("data", (text: string) => opts.onStderr?.(text));
    this.process.stdin!.on("error", () => {});
    this.exited = new Promise((resolve) => {
      const finish = (error?: Error) => { if (this.ended) return; this.ended = true; this.onClose(error); resolve(); };
      this.process.once("error", finish);
      this.process.once("close", (code) => finish(code === 0 ? undefined : new Error(`SSH channel exited (${code})`)));
    });
  }
  write(message: string) { if (!this.ended && this.process.stdin?.writable) this.process.stdin.write(toLine(message)); }
  async close() {
    if (this.ended) return;
    this.process.stdin?.end();
    const wait = async (ms: number) => { let t: ReturnType<typeof setTimeout> | undefined; await Promise.race([this.exited, new Promise<void>((r) => { t = setTimeout(r, ms); })]); clearTimeout(t); };
    await wait(2000);
    if (!this.ended) { this.process.kill(); await wait(3000); }
    if (!this.ended) { this.process.kill("SIGKILL"); await this.exited; }
  }
}

export async function runSsh(machine: Machine, command: string, opts: { input?: Uint8Array; timeoutMs?: number; executable?: string[] } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const base = opts.executable ?? ["ssh"];
  const child = spawn(base[0]!, [...base.slice(1), ...sshArgs(machine), "-o", "ClearAllForwardings=yes", machine.host, command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout!.setEncoding("utf8").on("data", (s: string) => { stdout = (stdout + s).slice(-64_000); });
  child.stderr!.setEncoding("utf8").on("data", (s: string) => { stderr = (stderr + s).slice(-8000); });
  child.stdin!.on("error", () => {});
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 20_000);
  try {
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin!.end(opts.input);
    const code = await closed;
    if (timedOut) throw new Error("SSH command timed out");
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

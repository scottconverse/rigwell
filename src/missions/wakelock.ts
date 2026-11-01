// Wake lock while a mission runs (spec §15.6): ref-counted; released with terminate, then kill after 2 s.
// macOS caffeinate; Linux systemd-inhibit, else gnome-session-inhibit; Windows a PowerShell loop.

export interface LockProc { kill(signal?: string): void; exited: Promise<unknown> }
export type LockSpawner = (cmd: string[]) => LockProc | undefined;

export function lockCommand(platform: NodeJS.Platform, pid: number, which: (n: string) => string | null | undefined): string[] | undefined {
  if (platform === "darwin") return ["caffeinate", "-i", "-w", String(pid)];
  if (platform === "linux") {
    if (which("systemd-inhibit")) {
      return ["systemd-inhibit", "--what=sleep:idle:handle-lid-switch", "--who=rigwell", "--why=Mission running", "--mode=block",
        "sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`];
    }
    if (which("gnome-session-inhibit")) {
      return ["gnome-session-inhibit", "--inhibit", "suspend:idle", "--reason", "Mission running", "sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`];
    }
    return undefined;
  }
  if (platform === "win32") {
    const ps = `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 30 }`;
    return ["powershell", "-NoProfile", "-Command", ps];
  }
  return undefined;
}

export class WakeLock {
  private n = 0;
  private proc?: LockProc;
  constructor(private spawn: LockSpawner | undefined, private killDelayMs = 2000) {}

  get count() { return this.n; }
  get held() { return !!this.proc; }

  acquire() {
    this.n++;
    if (this.n === 1 && this.spawn) {
      try { this.proc = this.spawn([]); } catch { this.proc = undefined; }
    }
  }

  release() {
    if (this.n === 0) return;
    this.n--;
    if (this.n > 0 || !this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    try { p.kill("SIGTERM"); } catch { /* gone */ }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, this.killDelayMs);
    void p.exited.then(() => clearTimeout(t), () => clearTimeout(t));
  }
}

/** The real spawner: picks the platform command, or does nothing when none applies or RIGWELL_NO_WAKE_LOCK=1. */
export const systemLockSpawner: LockSpawner = () => {
  if (process.env.RIGWELL_NO_WAKE_LOCK === "1") return undefined;
  const cmd = lockCommand(process.platform, process.pid, (n) => Bun.which(n));
  if (!cmd) return undefined;
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return { kill: (s) => p.kill(s as any), exited: p.exited };
  } catch { return undefined; }
};

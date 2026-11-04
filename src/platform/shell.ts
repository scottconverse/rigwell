import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

/**
 * The platform command shell used for user-written command strings (hooks, credential commands).
 * Spec 5.6: Windows runs `%ComSpec% /d /s /c <cmd>` (fallback C:\Windows\System32\cmd.exe); everywhere else `sh -c`.
 */
export interface ShellInvocation {
  file: string;
  args: string[];
  /** True on Windows: the command line is passed to cmd.exe as is (no extra argument escaping). */
  windowsVerbatimArguments: boolean;
}

export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ShellInvocation {
  if (platform === "win32") {
    // With /s, cmd strips the outer pair of quotes and runs the rest unchanged. Node would otherwise escape
    // inner quotes with a backslash, which cmd does not understand, so the line is passed verbatim.
    return {
      file: env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: "sh", args: ["-c", command], windowsVerbatimArguments: false };
}

/** Kill a child and everything it started. Windows has no process groups, so `taskkill /T` walks the tree. */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  try {
    if (platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Spawn a command string with the platform shell. */
export function spawnShell(command: string, options: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  const inv = shellInvocation(command);
  return spawn(inv.file, inv.args, { ...options, ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }) as ChildProcessWithoutNullStreams;
}

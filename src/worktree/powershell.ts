// Windows runner pieces for worktree setup and cleanup scripts (spec 18.3). Only argv and env construction live
// here, so they can be unit-tested on any host through an injectable spawner (see scripts.ts). Nothing in this file
// has been run on Windows.
//
// The spec names `powershell.exe -NoProfile -NonInteractive -Command`. This build writes the script to a temporary
// .ps1 file and runs it with `-File` plus `-ExecutionPolicy Bypass`, because -Command mangles multi-line scripts and
// quotes, and the default execution policy refuses -File scripts. `pwsh` (PowerShell 7) is preferred when installed.
import { isSecretName } from "./env.ts";

export interface PowerShellPlan {
  /** Full argv: [shell, ...flags, "-File", scriptPath]. */
  argv: string[];
  /** The .ps1 text to write at scriptPath (UTF-8 with BOM, so Windows PowerShell 5.1 reads non-ASCII correctly). */
  scriptText: string;
  scriptPath: string;
  env: Record<string, string>;
}

/** pwsh when available, else powershell.exe (always present on Windows). */
export function pickPowerShell(which: (name: string) => string | null | undefined): string {
  return which("pwsh") ?? which("pwsh.exe") ?? "powershell.exe";
}

/**
 * Wraps the user's script: stop on the first error, quiet progress output, and pass through the exit code of a
 * failing native command (PowerShell otherwise ends such a script with exit code 0).
 */
export function wrapScript(script: string): string {
  return "﻿$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\n" +
    script.replace(/\r?\n/g, "\r\n") +
    "\r\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\r\n";
}

/**
 * Environment for a Windows script: secrets stripped (names compared case-insensitively, as Windows does), REPO_ROOT_PATH
 * added, and PATH/Path left exactly as inherited (no login shell exists there).
 */
export function windowsScriptEnv(base: Record<string, string | undefined>, repoRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.toUpperCase() === "REPO_ROOT_PATH") continue;
    if (isSecretName(k) || isSecretName(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.REPO_ROOT_PATH = repoRoot;
  return env;
}

export function planPowerShell(o: {
  script: string; repoRoot: string; scriptPath: string; env: Record<string, string | undefined>;
  which?: (name: string) => string | null | undefined;
}): PowerShellPlan {
  const shell = pickPowerShell(o.which ?? (() => undefined));
  return {
    argv: [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", o.scriptPath],
    scriptText: wrapScript(o.script),
    scriptPath: o.scriptPath,
    env: windowsScriptEnv(o.env, o.repoRoot),
  };
}

/** Command that ends a process and its children (Bun's kill reaches only the shell). */
export function taskkillArgv(pid: number): string[] {
  return ["taskkill", "/PID", String(pid), "/T", "/F"];
}

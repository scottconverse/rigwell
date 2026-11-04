// Runs a setup or cleanup script (spec §18.3): in the worktree, secrets stripped, REPO_ROOT_PATH added,
// output capped at 4 KB with control characters removed, hard timeout.
// POSIX hosts run it with bash/sh -c. Windows runs it through PowerShell (see powershell.ts); that path is only
// unit-tested here, through the injectable spawner, because this build host is Linux.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripSecrets } from "./env.ts";
import { planPowerShell, taskkillArgv } from "./powershell.ts";

export const SETUP_TIMEOUT_MS = 20 * 60_000;
export const CLEANUP_TIMEOUT_MS = 5 * 60_000;
export const OUTPUT_CAP = 4096;

const SHELL = Bun.which("bash") ? "bash" : "sh";
let loginPath: string | undefined;

/** PATH as a login shell sees it (so tools from the user's profile are found). Only PATH is taken from it. */
async function loginShellPath(): Promise<string | undefined> {
  if (loginPath !== undefined) return loginPath;
  try {
    const p = Bun.spawn([SHELL, "-lc", 'printf %s "$PATH"'], { env: stripSecrets(process.env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout as ReadableStream).text();
    clearTimeout(t);
    loginPath = out.trim() || process.env.PATH || "";
  } catch {
    loginPath = process.env.PATH ?? "";
  }
  return loginPath;
}

export function cleanOutput(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clean.length > OUTPUT_CAP ? clean.slice(clean.length - OUTPUT_CAP) : clean;
}

export interface ScriptResult { ok: boolean; code: number | null; timedOut: boolean; output: string }

/** What runScript needs from a spawned process; Bun.spawn satisfies it. */
export interface SpawnedScript {
  pid?: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number): void;
}
export type ScriptSpawner = (argv: string[], o: { cwd: string; env: Record<string, string> }) => SpawnedScript;

const bunSpawner: ScriptSpawner = (argv, o) =>
  Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedScript;

export async function runScript(opts: {
  script: string; cwd: string; repoRoot: string; timeoutMs: number;
  /** Extra non-secret variables (secret-looking names are still stripped). */
  env?: Record<string, string>;
  onProgress?: (text: string) => void;
  /** Test seams: platform (default process.platform), spawner (default Bun.spawn), which (default Bun.which). */
  platform?: NodeJS.Platform;
  spawner?: ScriptSpawner;
  which?: (name: string) => string | null | undefined;
}): Promise<ScriptResult> {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawner ?? bunSpawner;
  const merged = { ...process.env, ...(opts.env ?? {}) };
  let argv: string[];
  let env: Record<string, string>;
  let tempDir: string | undefined;
  if (platform === "win32") {
    tempDir = mkdtempSync(path.join(tmpdir(), "rigwell-ps-"));
    const plan = planPowerShell({ script: opts.script, repoRoot: opts.repoRoot, scriptPath: path.join(tempDir, "script.ps1"), env: merged, which: opts.which ?? ((n) => Bun.which(n)) });
    writeFileSync(plan.scriptPath, plan.scriptText, "utf8");
    argv = plan.argv;
    env = plan.env;
  } else {
    env = stripSecrets(merged);
    const p = await loginShellPath();
    if (p) env.PATH = p;
    env.REPO_ROOT_PATH = opts.repoRoot;
    argv = [SHELL, "-c", opts.script];
  }
  try {
    const proc = spawn(argv, { cwd: opts.cwd, env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (platform === "win32" && proc.pid) { try { spawn(taskkillArgv(proc.pid), { cwd: opts.cwd, env }); } catch { /* fall through to kill */ } }
      proc.kill(9);
    }, opts.timeoutMs);
    let out = "";
    const pump = async (s: ReadableStream<Uint8Array> | null) => {
      if (!s) return;
      const dec = new TextDecoder();
      for await (const chunk of s) {
        const text = dec.decode(chunk, { stream: true });
        out = cleanOutput(out + text);
        opts.onProgress?.(cleanOutput(text));
      }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: !timedOut && code === 0, code: timedOut ? null : code, timedOut, output: out };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

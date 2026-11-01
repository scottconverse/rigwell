// Runs a setup or cleanup script (spec §18.3): in the worktree, secrets stripped, REPO_ROOT_PATH added,
// output capped at 4 KB with control characters removed, hard timeout.
import { stripSecrets } from "./env.ts";

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

export async function runScript(opts: {
  script: string; cwd: string; repoRoot: string; timeoutMs: number;
  /** Extra non-secret variables (secret-looking names are still stripped). */
  env?: Record<string, string>;
  onProgress?: (text: string) => void;
}): Promise<ScriptResult> {
  const env = stripSecrets({ ...process.env, ...(opts.env ?? {}) });
  const p = await loginShellPath();
  if (p) env.PATH = p;
  env.REPO_ROOT_PATH = opts.repoRoot;
  const proc = Bun.spawn([SHELL, "-c", opts.script], { cwd: opts.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(9); }, opts.timeoutMs);
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) {
      const text = dec.decode(chunk, { stream: true });
      out = cleanOutput(out + text);
      opts.onProgress?.(cleanOutput(text));
    }
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { ok: !timedOut && code === 0, code: timedOut ? null : code, timedOut, output: out };
}

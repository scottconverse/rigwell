import { spawn } from "node:child_process";

export interface RgResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when we stopped rg early because maxLines was exceeded. */
  cut: boolean;
  missing: boolean;
}

/** Runs rg without a shell. Stops after maxLines+1 lines of stdout (cut = true). */
export function runRg(args: string[], cwd: string, signal: AbortSignal, maxLines = Infinity): Promise<RgResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", cut: false, missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let cut = false;
    let missing = false;
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      if (cut) return;
      stdout += s;
      if (maxLines !== Infinity) {
        let n = 0;
        let idx = -1;
        while ((idx = stdout.indexOf("\n", idx + 1)) !== -1) n++;
        if (n > maxLines) {
          cut = true;
          child.kill("SIGKILL");
        }
      }
    });
    child.stderr.on("data", (s: string) => {
      if (stderr.length < 10_000) stderr += s;
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") missing = true;
      else stderr += e.message;
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, cut, missing });
    });
  });
}

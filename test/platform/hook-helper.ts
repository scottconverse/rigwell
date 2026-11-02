import { runCommand } from "../../src/hooks/runner.ts";
import { jsCommand } from "../platform.ts";

/** Runs a hook-style command (stdin in, stderr and stdout out, exit 2) through the real platform shell. */
export function runHookCommandForTest(dir: string) {
  const command = jsCommand(dir, `let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { console.error("said-no"); console.log("seen:" + s); process.exit(2); });`);
  return runCommand(command, { cwd: dir, stdin: "hello", timeoutS: 20 });
}

import { resolve } from "node:path";
import { generateReadinessReport, readReadinessReport, readinessPlan } from "./readiness-report.ts";

export async function readinessMain(argv: string[]) {
  let cwd = process.cwd(), run = false; const plan: Record<string, unknown> = {}, tools: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { const v = argv[++i]; if (!v) throw new Error(`${arg} needs a value`); return v; };
    if (arg === "--cwd") cwd = resolve(value());
    else if (arg === "--build") plan.buildCommand = value();
    else if (arg === "--test") plan.testCommand = value();
    else if (arg === "--tool") tools.push(value());
    else if (arg === "--timeout-ms") plan.timeoutMs = Number(value());
    else if (arg === "--run") run = true;
    else if (arg === "--help") { process.stdout.write('rigwell readiness-report [--cwd <folder>] [--build "command"] [--test "command"] [--tool executable] [--timeout-ms 120000] [--run]\nWithout --run only reads the saved local report. --run approves these exact commands, which execute repository code in the normal tool shell. No command is inferred from repository configuration.\n'); return; }
    else throw new Error(`Unknown readiness option ${arg}`);
  }
  if (tools.length) plan.tools = tools;
  const parsed = readinessPlan(plan);
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const result = run ? await generateReadinessReport(cwd, parsed, { cwd, sessionId: "readiness-cli", readFiles: new Map(), signal: controller.signal }) : readReadinessReport(cwd);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (run && (result as { level: number }).level < 4) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}

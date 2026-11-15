import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ToolContext } from "../core/types.ts";
import { createExecuteTool, resolveShell } from "../tools/execute.ts";
import { realGit } from "./readiness.ts";
import { redactSharedText } from "../sharing/redact.ts";
export const readinessRepoIdentity = (url: string | null) => createHash("sha256").update(url ?? "").digest("hex");

export interface ReadinessPlan { buildCommand?: string; testCommand?: string; tools: string[]; timeoutMs: number }
export function readinessPlan(value: unknown): ReadinessPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Readiness plan must be an object");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((k) => !["buildCommand", "testCommand", "tools", "timeoutMs"].includes(k))) throw new Error("Unknown readiness plan field");
  for (const k of ["buildCommand", "testCommand"]) if (p[k] !== undefined && (typeof p[k] !== "string" || (p[k] as string).length > 4096 || !(p[k] as string).trim())) throw new Error(`${k} must be a nonempty command up to 4096 characters`);
  const tools = p.tools ?? ["git"];
  if (!Array.isArray(tools) || tools.length > 32 || tools.some((t) => typeof t !== "string" || !/^[a-zA-Z0-9_.+-]{1,100}$/.test(t))) throw new Error("tools must contain at most 32 executable names");
  const timeoutMs = p.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 600000) throw new Error("timeoutMs must be 1..600000");
  return { ...(p.buildCommand ? { buildCommand: p.buildCommand as string } : {}), ...(p.testCommand ? { testCommand: p.testCommand as string } : {}), tools: [...new Set(["git", ...tools])], timeoutMs: timeoutMs as number };
}

function location(cwd: string) {
  const folder = realpathSync(cwd), top = realGit(["rev-parse", "--show-toplevel"], folder);
  return { folder, root: top ? realpathSync(top) : folder };
}
export const readinessRoot = (cwd: string) => location(cwd).root;
function reportPath(root: string) {
  const dir = join(root, ".rigwell"), file = join(dir, "readiness-report.json");
  for (const p of [dir, file]) { try { const st = lstatSync(p); if (st.isSymbolicLink() || (p === dir ? !st.isDirectory() : !st.isFile())) throw new Error("Readiness paths must be regular and unlinked"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  return { dir, file };
}
export function readReadinessReport(cwd: string) {
  const { root } = location(cwd), { file } = reportPath(root);
  if (!existsSync(file)) return { root, report: null };
  if (lstatSync(file).size > 65536) throw new Error("Readiness report exceeds 64 KiB");
  return { root, report: JSON.parse(readFileSync(file, "utf8")) };
}

// Callers must obtain approval for the exact plan before invoking this function.
export async function generateReadinessReport(cwd: string, input: unknown, ctx: ToolContext) {
  const plan = readinessPlan(input), { root } = location(cwd), { dir, file } = reportPath(root);
  const repoUrl = realGit(["remote", "get-url", "origin"], root), head = realGit(["rev-parse", "HEAD"], root);
  const tools = plan.tools.map((name) => ({ name, status: Bun.which(name) ? "passed" : "failed" }));
  tools.push({ name: "command shell", status: existsSync(resolveShell().path) ? "passed" : "failed" });
  const checks: { name: string; command?: string; status: "passed" | "failed" | "not_checked"; exitCode?: number | null; durationMs?: number }[] = [];
  for (const [name, command] of [["build", plan.buildCommand], ["tests", plan.testCommand]] as const) {
    if (!command || ctx.signal.aborted) { checks.push({ name, ...(command ? { command: redactSharedText(command) } : {}), status: "not_checked" }); continue; }
    const result = await createExecuteTool().run({ command, cwd: root, timeoutMs: plan.timeoutMs }, { ...ctx, cwd: root, jobs: undefined });
    const data = result.data as { exitCode?: number | null; durationMs?: number } | undefined;
    checks.push({ name, command: redactSharedText(command), status: result.isError ? "failed" : "passed", ...(data ? { exitCode: data.exitCode, durationMs: data.durationMs } : {}) });
  }
  const passed = tools.every((t) => t.status === "passed") && checks.every((c) => c.status === "passed");
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), repoUrl: repoUrl ? redactSharedText(repoUrl) : null, repoIdentity: readinessRepoIdentity(repoUrl), root, head, level: passed ? 4 : 2, tools, checks, cancelled: ctx.signal.aborted, coverage: "Point-in-time local commands and executable presence. No raw command output retained. Does not prove future changes, test completeness, installed behavior or provider access." };
  // Revalidate after commands, which can modify repository paths.
  reportPath(root); mkdirSync(dir, { recursive: true }); const tmp = join(dir, `.readiness-${crypto.randomUUID()}.tmp`);
  try { writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); reportPath(root); renameSync(tmp, file); } finally { try { unlinkSync(tmp); } catch {} }
  return report;
}

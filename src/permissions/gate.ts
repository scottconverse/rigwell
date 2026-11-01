import * as path from "node:path";
import type { AutonomyLevel, PermissionContext, PermissionDecision, RiskLevel } from "../core/types.ts";
import { classifyCommand } from "./command.ts";

const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
const AUTONOMY_RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function insideSpecs(p: string, cwd: string): boolean {
  const dir = path.join(cwd, ".rigwell", "specs") + path.sep;
  return path.resolve(cwd, p).startsWith(dir);
}

const SPEC_BLOCK =
  "Spec mode is active: files cannot be created or edited, except plan files under .rigwell/specs/. " +
  "Research with the read-only tools, then propose your plan.";

export function decide(tool: string, input: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  if (ctx.skipPermissions) return { decision: "allow", reason: "permissions skipped" };
  switch (tool) {
    case "Read":
    case "Grep":
    case "Glob":
      return { decision: "allow" };
    case "Edit":
    case "Create":
      return decideFileWrite(tool, input, ctx);
    case "Execute":
      return decideExecute(input, ctx);
    default:
      return { decision: "ask", confirmationType: "exec", details: { toolName: tool, input }, impactLevel: "high", alwaysLevel: null, reason: `Unknown tool: ${tool}` };
  }
}

function decideFileWrite(tool: "Edit" | "Create" | string, input: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  const p = str(input.path) ?? "";
  if (ctx.interactionMode === "spec" && !(p && insideSpecs(p, ctx.cwd))) {
    return { decision: "block", message: SPEC_BLOCK };
  }
  if (ctx.autonomy !== "off") return { decision: "allow" };
  const filePath = p ? path.resolve(ctx.cwd, p) : p;
  const fileName = path.basename(filePath);
  if (tool === "Edit") {
    return {
      decision: "ask",
      confirmationType: "edit",
      details: { filePath, fileName, oldContent: str(input.old_text), newContent: str(input.new_text) },
      impactLevel: "medium",
      alwaysLevel: "low",
    };
  }
  return {
    decision: "ask",
    confirmationType: "create",
    details: { filePath, fileName, content: str(input.content) ?? "" },
    impactLevel: "medium",
    alwaysLevel: "low",
  };
}

function decideExecute(input: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  const command = str(input.command) ?? "";
  const rawRisk = input.riskLevel;
  if (rawRisk === undefined || rawRisk === null || rawRisk === "") {
    return {
      decision: "missing_risk",
      message:
        "Missing risk classification. The command was not run. Send the call again with riskLevel (low, medium or high) and riskReason filled in.",
    };
  }
  const risk: RiskLevel = rawRisk === "low" || rawRisk === "medium" || rawRisk === "high" ? rawRisk : "high";
  const spec = ctx.interactionMode === "spec";
  const cls = classifyCommand(command, ctx.lists);

  if (cls.kind === "block") {
    return { decision: "block", message: `Blocked command: ${cls.match.reason}. This command is not allowed to run.` };
  }
  if (cls.kind === "ask") {
    if (spec) {
      return { decision: "block", message: `Spec mode is active and this command is high impact (${cls.match.reason}). Use read-only commands.` };
    }
    return {
      decision: "ask",
      confirmationType: "exec",
      details: { fullCommand: command, command: cls.match.segment, impactLevel: "high", riskLevelReason: str(input.riskReason) },
      impactLevel: "high",
      alwaysLevel: null,
      reason: cls.match.reason,
    };
  }
  if (cls.kind === "allow") return { decision: "allow", reason: cls.match.reason };
  if (spec && risk !== "low") {
    return {
      decision: "block",
      message: `Spec mode is active: only read-only (low risk) commands may run, and this one was rated ${risk}. Propose it in your plan instead.`,
    };
  }
  if (RISK_RANK[risk] <= AUTONOMY_RANK[ctx.autonomy]) return { decision: "allow" };
  return {
    decision: "ask",
    confirmationType: "exec",
    details: { fullCommand: command, command, impactLevel: risk, riskLevelReason: str(input.riskReason) },
    impactLevel: risk,
    alwaysLevel: risk,
  };
}

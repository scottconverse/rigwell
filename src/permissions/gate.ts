import * as path from "node:path";
import type { AutonomyLevel, PermissionContext, PermissionDecision, RiskLevel } from "../core/types.ts";
import { classifyCommand } from "./command.ts";

const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
const AUTONOMY_RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function insideSpecs(p: string, cwd: string): boolean {
  const dir = path.resolve(cwd, ".rigwell", "specs") + path.sep;
  const target = path.resolve(cwd, p);
  // Windows paths are case-insensitive.
  return process.platform === "win32" ? target.toLowerCase().startsWith(dir.toLowerCase()) : target.startsWith(dir);
}

const SPEC_BLOCK =
  "Spec mode is active: files cannot be created or edited, except plan files under .rigwell/specs/. " +
  "Research with the read-only tools, then propose your plan.";

export function decide(tool: string, input: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  // Mission mode runs at high autonomy (spec 5.5.3); file protection is enforced by the mission tool wrappers.
  if (ctx.interactionMode === "mission" && ctx.autonomy !== "high") ctx = { ...ctx, autonomy: "high" };
  if (ctx.skipPermissions) return { decision: "allow", reason: "permissions skipped" };
  switch (tool) {
    case "Read":
    case "LS":
    case "Grep":
    case "Glob":
      return { decision: "allow" };
    // Session tools: they only read or change the session's own state (jobs, todos, questions, the answer).
    case "TaskOutput":
    case "TaskStop":
    case "TodoWrite":
    case "AskUser":
    case "StructuredOutput":
    // RecommendMission and UpgradeModel ask the user themselves (the session handles them).
    case "RecommendMission":
    case "UpgradeModel":
      return { decision: "allow" };
    // Network: ask at Off, auto at Low and above (spec 5.5.4).
    case "FetchUrl":
      if (ctx.autonomy !== "off") return { decision: "allow" };
      return {
        decision: "ask", confirmationType: "fetch_url", details: { toolName: tool, url: str(input.url) ?? "", input },
        impactLevel: "medium", alwaysLevel: "low", reason: "Fetches a web page",
      };
    case "ApplyPatch":
      return decideApplyPatch(input, ctx);
    // Script and script_job themselves need no approval: each inner call is gated on its own (spec S8).
    case "Script":
    case "script_job":
      return { decision: "allow" };
    // Loading a deferred tool changes nothing on disk; calling it is gated on its own (session.gate).
    // Mission tools confirm with the user themselves (src/missions/tools.ts).
    case "ProposeMission":
    case "StartMissionRun":
    case "DismissHandoffItems":
    case "EndFeatureRun":
      return { decision: "allow" };
    case "load_tools":
    case "ToolSearch":
      return { decision: "allow" };
    // Browser pane tool (src/sidepane/browser.ts): looking is free; acting on a page needs autonomy low or higher.
    case "Browser": {
      const a = str(input.action) ?? "";
      if (["tabs", "snapshot", "screenshot"].includes(a) || ctx.autonomy !== "off") return { decision: "allow" };
      return { decision: "ask", confirmationType: "exec", details: { toolName: tool, input }, impactLevel: "medium", alwaysLevel: "low", reason: "Drives the browser pane" };
    }
    // Automation tools (src/automations/tools.ts): reading is free; anything that creates, changes, deletes or starts a run
    // always asks, so an unattended run (which cannot prompt) cannot make or change automations.
    case "ListAutomations":
    case "ReadAutomation":
    case "ListAutomationTemplates":
    case "PreviewSchedule":
      return { decision: "allow" };
    case "Loop":
      if (input.action === "list") return { decision: "allow" };
    // falls through
    case "CreateAutomation":
    case "EditAutomation":
    case "DeleteAutomation":
    case "RunAutomation":
      return { decision: "ask", confirmationType: "exec", details: { toolName: tool, input }, impactLevel: "medium", alwaysLevel: null, reason: `${tool} changes or starts scheduled work` };
    case "Edit":
    case "Create":
      return decideFileWrite(tool, input, ctx);
    case "Execute":
      return decideExecute(input, ctx);
    default:
      return { decision: "ask", confirmationType: "exec", details: { toolName: tool, input }, impactLevel: "high", alwaysLevel: null, reason: `Unknown tool: ${tool}` };
  }
}

function patchTargets(text: string): string[] {
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
}

function decideApplyPatch(input: Record<string, unknown>, ctx: PermissionContext): PermissionDecision {
  const patch = str(input.input) ?? "";
  const targets = patchTargets(patch);
  if (ctx.interactionMode === "spec" && !(targets.length && targets.every((t) => insideSpecs(t, ctx.cwd)))) {
    return { decision: "block", message: SPEC_BLOCK };
  }
  if (ctx.autonomy !== "off") return { decision: "allow" };
  const filePath = targets[0] ? path.resolve(ctx.cwd, targets[0]) : "";
  return {
    decision: "ask", confirmationType: "apply_patch",
    details: { filePath, fileName: path.basename(filePath), filePaths: targets.map((t) => path.resolve(ctx.cwd, t)), patch },
    impactLevel: "medium", alwaysLevel: "low",
  };
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

// Tools the session adds to the core set: Skill (spec 5.8), Task (spec 5.9, prompts.md 5.14) and ExitSpecMode (spec 5.5.7).
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolOutput } from "../core/types.ts";
import { runSkill, SkillError, type SkillRegistry } from "../skills/skills.ts";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";

export function skillTool(reg: SkillRegistry): Tool {
  return {
    name: "Skill",
    description: PROMPT_TEXT.tool_Skill_desc,
    inputSchema: JSON.parse(PROMPT_TEXT.tool_Skill_schema),
    category: "read",
    run: async (input): Promise<ToolOutput> => {
      try {
        const r = runSkill(reg, { name: String(input.name ?? ""), args: typeof input.args === "string" ? input.args : undefined });
        return { content: r.instructions, data: r };
      } catch (e) {
        if (e instanceof SkillError) return { content: e.message, isError: true };
        throw e;
      }
    },
  };
}

/** The Task description with the agent catalog appended when the session lists custom agents. */
export function taskDescription(catalog: string[]): string {
  return catalog.length ? `${PROMPT_TEXT.tool_Task_desc}\nCustom agents you can name in agent:\n${catalog.map((l) => `- ${l}`).join("\n")}` : PROMPT_TEXT.tool_Task_desc;
}

export function taskTool(catalog: string[], run: Tool["run"]): Tool {
  return {
    name: "Task",
    description: taskDescription(catalog),
    inputSchema: JSON.parse(PROMPT_TEXT.tool_Task_schema),
    category: "other",
    run,
  };
}

export const EXIT_SPEC_DESC =
  "Proposes your finished plan for the user to approve and ends spec mode when they do. Call it once, after you have investigated with the read-only tools.\n" +
  "- plan: the complete plan in markdown: what you will change, in which files, in what order, and how you will verify it.\n" +
  "- title: a short name for the plan.\n" +
  "The user may approve it (with a chosen autonomy level), edit it first, or send it back with a comment. If it is sent back, keep investigating or revise the plan and propose again. Nothing is changed while spec mode is on.";

export function exitSpecModeTool(): Tool {
  return {
    name: "ExitSpecMode",
    description: EXIT_SPEC_DESC,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, plan: { type: "string" } },
      required: ["plan"],
      additionalProperties: false,
    },
    category: "other",
    // The session handles this tool itself (confirmation, mode change); run is never reached.
    run: async () => ({ content: "ExitSpecMode is handled by the session.", isError: true }),
  };
}

/** Folder for approved specs: settings `specSaveDir` (`~` allowed; relative paths are under the working folder), default `.rigwell/docs`. */
export function specSaveFolder(cwd: string, specSaveDir?: string): string {
  const raw = specSaveDir && specSaveDir.trim() ? specSaveDir.trim() : ".rigwell/docs";
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(cwd, expanded);
}

export function specFileName(title: string | undefined, now = new Date()): string {
  const slug = (title ?? "spec").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "spec";
  return `${now.toISOString().slice(0, 10)}-${slug}.md`;
}

export function saveSpec(dir: string, file: string, title: string | undefined, plan: string): string {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const body = plan.startsWith("#") || !title ? plan : `# ${title}\n\n${plan}`;
  writeFileSync(target, body.endsWith("\n") ? body : body + "\n");
  return target;
}

export function recommendMissionTool(): Tool {
  return {
    name: "RecommendMission",
    description:
      "Suggests switching this session to mission mode, for large work that splits into many features and needs planning and validation. The user is asked and may decline.\n" +
      "- reason: why this work suits a mission (scope, number of parts, need for validation).\n" +
      "Use it rarely, only for work that is clearly too big for one session. If the user declines, carry on here.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    category: "other",
    run: async () => ({ content: "RecommendMission is handled by the session.", isError: true }),
  };
}

export function upgradeModelTool(): Tool {
  return {
    name: "UpgradeModel",
    description:
      "Asks the user to switch this session to a stronger model, when the current one is not able to do the task (for example after repeated failures on a hard problem). The user is asked and may decline.\n" +
      "- reason: what the current model could not do and why a stronger one should.\n" +
      "Use it as a last resort, not for routine work.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    category: "other",
    run: async () => ({ content: "UpgradeModel is handled by the session.", isError: true }),
  };
}

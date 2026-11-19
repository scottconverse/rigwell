import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Tool } from "../core/types.ts";
import { parsePatch } from "../tools/apply-patch.ts";
import { resolvePath } from "../tools/util.ts";

export interface MemberWriteScope { name: string; writeFiles: string[] }

export function approvedWriteScopes(agents: unknown): MemberWriteScope[] | undefined {
  if (!Array.isArray(agents) || !agents.some((agent) => agent && typeof agent === "object" && "writeFiles" in agent)) return undefined;
  const scopes: MemberWriteScope[] = [];
  const names = new Set<string>();
  for (const agent of agents) {
    const name = typeof agent?.name === "string" ? agent.name.trim() : "";
    if (!name || names.has(name.toLowerCase()) || !Array.isArray(agent.writeFiles)) {
      throw new Error("A scoped proposal requires a unique name and an explicit writeFiles array for every member");
    }
    const writeFiles = agent.writeFiles.map((file: unknown) => {
      if (typeof file !== "string" || !file || file !== file.trim()) throw new Error("Write files must be exact worktree-relative file paths");
      const parts = file.split(/[/\\]/);
      if (parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(\.git|\.rigwell|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
        throw new Error(`Unsafe or non-relative Workstream write file: ${file}`);
      }
      return parts.join("/");
    });
    names.add(name.toLowerCase());
    scopes.push({ name, writeFiles: [...new Set<string>(writeFiles)] });
  }
  return scopes;
}

// Only these direct tools can run automatically for a scoped member. Scripts, extensions and native tools
// are separate execution paths and cannot inherit a file allowlist merely by displaying it to the model.
export const scopedMemberTools = ["Read", "LS", "Grep", "Glob", "Create", "Edit", "ApplyPatch", "AskUser", "TodoWrite", "ListAgents", "SendMessage", "CreateListener"];

function fileInScope(raw: string, cwd: string, files: string[]): boolean {
  const target = resolvePath(raw, cwd);
  const rel = relative(cwd, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const parts = rel.split(sep);
  const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!files.some((file) => canonical(file) === canonical(parts.join("/")))) return false;
  // Check the root and each existing component. A symlink, junction or hard link can write outside the assignment.
  if (canonical(realpathSync(cwd)) !== canonical(resolve(cwd))) return false;
  let current = cwd;
  for (const [index, component] of parts.entries()) {
    current = resolve(current, component);
    try {
      const stat = lstatSync(current);
      if (index === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

export function guardMemberWrites(tool: Tool, files: string[], denied: (paths: string[]) => void): Tool {
  if (!["Create", "Edit", "ApplyPatch"].includes(tool.name)) return tool;
  return { ...tool, async run(input, ctx) {
    let paths: string[];
    try {
      paths = tool.name === "ApplyPatch" ? parsePatch(String(input.input ?? "")).map((op) => op.path) : [String(input.path ?? "")];
      if (paths.every((path) => fileInScope(path, ctx.cwd, files))) return tool.run(input, ctx);
    } catch (error) {
      return { isError: true, content: `Cannot verify Workstream write scope: ${(error as Error).message}` };
    }
    denied(paths);
    return { isError: true, content: "Write denied by the approved Workstream file assignment. Ask the lead to handle the operation." };
  } };
}

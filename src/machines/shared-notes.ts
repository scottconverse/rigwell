import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileReadRecord, ToolContext } from "../core/types.ts";
import { createReadTool } from "../tools/read.ts";
import { createCreateTool } from "../tools/create.ts";
import { createEditTool } from "../tools/edit.ts";

const realTarget = (path: string): string => {
  try { lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return dirname(path) === path ? path : join(realTarget(dirname(path)), basename(path));
  }
  return realpathSync(path); // A dangling link must fail, rather than be treated as a new file.
};
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); };
export class SharedNotes {
  private reads = new Map<string, FileReadRecord>();
  constructor(readonly root: string, private sessionId: string, private allowed?: string[]) {}
  async run(name: unknown, input: unknown) {
    if (typeof name !== "string" || !["Read", "Create", "Edit"].includes(name) || this.allowed && !this.allowed.includes(name)) throw new Error("Shared note tool is unavailable");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid shared note request");
    const p = input as Record<string, unknown>;
    if (typeof p.path !== "string" || !isAbsolute(p.path) || !inside(resolve(this.root), resolve(p.path)) || !inside(realpathSync(this.root), realTarget(resolve(p.path)))) throw new Error("Shared note path must remain inside the approved shared folder");
    const tool = name === "Read" ? createReadTool() : name === "Create" ? createCreateTool() : createEditTool();
    const ctx: ToolContext = { cwd: this.root, sessionId: this.sessionId, readFiles: this.reads, signal: new AbortController().signal };
    return tool.run(p, ctx);
  }
}

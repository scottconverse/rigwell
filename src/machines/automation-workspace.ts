// Only routing metadata travels from the scheduler. Credentials and project settings stay remote.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export function automationWorkspace(id: unknown, cwd?: unknown) {
  if (typeof id !== "string" || !id || id.length > 256) throw new Error("automationId is required");
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd || cwd.includes("\0"))) throw new Error("Invalid remote working directory");
  const key = createHash("sha256").update(id).digest("hex");
  let dir = rigwellHome();
  for (const part of ["automation-workspaces", key]) {
    dir = join(dir, part);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Automation workspace must be an unlinked directory");
  }
  for (const part of ["memory", "reports"]) {
    const path = join(dir, part);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Automation workspace must be an unlinked directory");
  }
  return { cwd: typeof cwd === "string" ? resolve(cwd) : dir, memory: join(dir, "memory"), reports: join(dir, "reports") };
}

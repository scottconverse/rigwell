import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tool } from "../core/types.ts";
import { missionDirFor } from "../missions/store.ts";
import { protectTools } from "../missions/protect.ts";
import { rigwellHome } from "../storage/paths.ts";

const allowed = (path: string) => /^(?:mission\.md|AGENTS\.md|features\.json|validation-contract\.md|validation-state\.json|services\.yaml|init\.sh|(?:skills|library)\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+)$/.test(path) && !path.split("/").some((s) => s === "." || s === "..");
const linked = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
export function missionPlanFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  let size = 0;
  const visit = (rel: string) => {
    const path = join(dir, rel), st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error("Remote mission plans cannot contain symlinks");
    if (st.isDirectory()) { for (const name of readdirSync(path)) visit(rel ? `${rel}/${name}` : name); return; }
    if (!allowed(rel)) return;
    size += st.size;
    if (size > 2_000_000) throw new Error("Remote mission plan exceeds 2 MB");
    files[rel] = readFileSync(path, "utf8");
  };
  for (const name of readdirSync(dir)) if (allowed(name) || ["skills", "library"].includes(name)) visit(name);
  return files;
}

/** Only approved library files cross back; local feature/system files remain authoritative. */
export function mergeMissionLibrary(dir: string, baseline: Record<string, string>, incoming: unknown): Record<string, string> {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || Buffer.byteLength(JSON.stringify(incoming)) > 2_100_000) throw new Error("Invalid remote mission library");
  const remote = incoming as Record<string, string>;
  for (const [rel, text] of Object.entries(remote)) if (!rel.startsWith("library/") || !allowed(rel) || typeof text !== "string") throw new Error("Invalid remote mission library file");
  const changes: { path: string; content?: string }[] = [];
  const files = new Set([...Object.keys(baseline).filter((p) => p.startsWith("library/")), ...Object.keys(remote)]);
  const destinations = new Set<string>();
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Mission library root must not be linked");
  for (const rel of files) {
    if (!allowed(rel)) throw new Error("Invalid mission library baseline");
    const destination = process.platform === "win32" ? rel.toLowerCase() : rel;
    if (destinations.has(destination)) throw new Error("Conflicting mission library filename casing");
    destinations.add(destination);
    if (baseline[rel] === remote[rel]) continue;
    let path = dir;
    for (const component of rel.split("/")) {
      path = join(path, component);
      if (linked(path)) throw new Error("Mission library paths must not be linked");
    }
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current !== baseline[rel] && current !== remote[rel]) throw new Error(`Mission library conflict: ${rel}. Local and remote copies were retained.`);
    if (current !== remote[rel]) changes.push({ path, content: remote[rel] });
  }
  // Validate the complete snapshot before applying any changes.
  for (const change of changes) {
    if (change.content === undefined) unlinkSync(change.path);
    else {
      mkdirSync(dirname(change.path), { recursive: true, mode: 0o700 });
      const stage = `${change.path}.incoming-${crypto.randomUUID()}`;
      try { writeFileSync(stage, change.content, { mode: 0o600, flag: "wx" }); renameSync(stage, change.path); }
      finally { if (existsSync(stage)) unlinkSync(stage); }
    }
  }
  return remote;
}

export function prepareMissionWorker(p: Record<string, unknown>, invoke: (input: Record<string, unknown>) => Promise<any>) {
  if (typeof p.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(p.sessionId)) throw new Error("Invalid worker session ID");
  if (typeof p.cwd !== "string" || !p.cwd || p.cwd.includes("\0")) throw new Error("Remote worker working directory is required");
  if (!p.files || typeof p.files !== "object" || Array.isArray(p.files) || JSON.stringify(p.files).length > 2_100_000) throw new Error("Invalid remote mission plan");
  const descriptor = p.tool as Omit<Tool, "run">;
  if (!descriptor || descriptor.name !== "EndFeatureRun" || typeof descriptor.description !== "string" || !descriptor.inputSchema || typeof descriptor.inputSchema !== "object") throw new Error("Invalid worker completion tool");
  const dir = missionDirFor(p.sessionId), cwd = resolve(p.cwd);
  const root = join(rigwellHome(), "missions");
  if (linked(root)) throw new Error("Remote mission root must not be linked");
  // Check every existing ancestor before creating or writing through it.
  for (const [rel, text] of Object.entries(p.files)) {
    if (!allowed(rel) || typeof text !== "string") throw new Error("Invalid remote mission plan file");
    let parent = dirname(dir);
    for (const component of [p.sessionId, ...rel.split("/")]) {
      parent = join(parent, component);
      if (linked(parent)) throw new Error("Remote mission paths must not be linked");
    }
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  }
  const tool: Tool = { ...descriptor, category: "other", run: (input) => invoke(input) };
  return { dir, cwd, wrap: (tools: Tool[]) => [...protectTools(tools.filter((t) => !["EndFeatureRun", "ProposeMission", "StartMissionRun", "DismissHandoffItems"].includes(t.name)), { role: "worker" }), tool] };
}

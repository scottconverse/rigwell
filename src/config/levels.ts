// Shared config-folder resolution for hooks, MCP, skills, agents (spec §12.2 "Settings levels").
// Rigwell folder names: user `$RIGWELL_HOME`, project `<root>/.rigwell`.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { rigwellHome, userHomeDir } from "../storage/paths.ts";

export type ConfigLevel = "folder" | "project" | "user";
export interface ConfigDir { level: ConfigLevel; dir: string }

export function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const contains = (outer: string, inner: string) => {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The project root: git root or cwd; null when it is the home dir or contains it ("no project"). */
export function projectRoot(cwd: string, homeDir?: string): string | null {
  const c = path.resolve(cwd);
  const root = findGitRoot(c) ?? c;
  const home = path.resolve(homeDir ?? userHomeDir());
  return contains(root, home) ? null : root;
}

/**
 * Config folders for a working dir, highest priority first:
 * folder levels (nearer cwd first, git repos only, git root excluded), then project, then user.
 */
export function configDirs(cwd: string, homeDir?: string): ConfigDir[] {
  const c = path.resolve(cwd);
  const out: ConfigDir[] = [];
  const user = rigwellHome();
  const root = projectRoot(c, homeDir);
  const gitRoot = findGitRoot(c);
  const projectDir = root ? path.join(root, ".rigwell") : null;
  if (gitRoot && root) {
    for (let d = c; d !== gitRoot && contains(gitRoot, d); d = path.dirname(d)) {
      const dir = path.join(d, ".rigwell");
      if (dir !== projectDir && dir !== user) out.push({ level: "folder", dir });
    }
  }
  if (projectDir) out.push({ level: "project", dir: projectDir });
  out.push({ level: "user", dir: user });
  return out;
}

export function readJsonObject(file: string, maxBytes = 1024 * 1024): { value: Record<string, unknown> | null; warning?: string } {
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { value: null };
    if (st.size > maxBytes) return { value: null, warning: `${file}: larger than ${maxBytes} bytes, ignored` };
    text = readFileSync(file, "utf8");
  } catch { return { value: null }; }
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j)) return { value: j as Record<string, unknown> };
    return { value: null, warning: `${file}: not a JSON object, ignored` };
  } catch (e) {
    return { value: null, warning: `${file}: invalid JSON (${(e as Error).message}), ignored` };
  }
}

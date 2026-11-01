// Readiness check when entering mission mode (spec §15.7): a warning, never a hard block.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export type Readiness = "ok" | "no_git" | "no_remote" | "no_report" | "low_score";
export interface ReadinessResult { status: Readiness; folder: string; detail?: string }

export type Git = (args: string[], cwd: string) => string | null;
export const realGit: Git = (args, cwd) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

const ackFile = () => join(rigwellHome(), "mission-readiness-warnings-shown.json");
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export function acknowledgedFolders(): string[] {
  try { const j = JSON.parse(readFileSync(ackFile(), "utf8")); return j?.version === 1 && Array.isArray(j.folders) ? j.folders : []; } catch { return []; }
}

export function acknowledgeFolder(folder: string) {
  const f = real(folder);
  const cur = acknowledgedFolders();
  if (cur.includes(f)) return;
  mkdirSync(dirname(ackFile()), { recursive: true });
  const tmp = ackFile() + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, folders: [...cur, f] }, null, 2) + "\n");
  renameSync(tmp, ackFile());
}

export function checkReadiness(cwd: string, git: Git = realGit): ReadinessResult {
  const folder = real(cwd);
  if (acknowledgedFolders().includes(folder)) return { status: "ok", folder, detail: "acknowledged" };
  try {
    if (readdirSync(folder).filter((n) => n !== ".git").length === 0) return { status: "ok", folder, detail: "empty folder" };
    if (git(["rev-parse", "--is-inside-work-tree"], folder) !== "true") return { status: "no_git", folder };
    const url = git(["remote", "get-url", "origin"], folder);
    if (!url) return { status: "no_remote", folder };
    const top = git(["rev-parse", "--show-toplevel"], folder) ?? folder;
    const file = join(top, ".rigwell", "readiness-report.json");
    if (!existsSync(file)) return { status: "no_report", folder };
    const rep = JSON.parse(readFileSync(file, "utf8"));
    if (rep?.repoUrl !== undefined && rep.repoUrl !== url) return { status: "no_report", folder, detail: "report is for another repository" };
    return Number(rep?.level) >= 4 ? { status: "ok", folder } : { status: "low_score", folder, detail: `level ${rep?.level}` };
  } catch {
    return { status: "ok", folder, detail: "check failed" }; // errors count as OK
  }
}

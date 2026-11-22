// Parallel mission workers: which features may run together, and the git work around them.
// Finished work goes to a separate mission branch. The user's own branch never changes.
import { realpathSync } from "node:fs";
import path from "node:path";
import { git, repoTopLevel } from "../worktree/git.ts";
import { WorktreeError, type WorktreeManager } from "../worktree/manager.ts";
import { isValidatorSkill, type Feature } from "./store.ts";

export const MAX_PARALLEL_WORKERS = 4;
export const clampWorkers = (n: unknown) => (typeof n === "number" && Number.isInteger(n) ? Math.min(MAX_PARALLEL_WORKERS, Math.max(1, n)) : 1);
export const isRemoteMachine = (m?: string) => !!m && !["local", "default"].includes(m);

const isDone = (f: Feature) => f.status === "completed" || f.status === "cancelled";

/** A path prefix for one file area. Case is ignored and a wildcard widens the area, so a doubt counts as an overlap. */
function areaPrefix(area: string): string[] {
  const parts = area.trim().replace(/\\/g, "/").toLowerCase().split("/").filter((p) => p && p !== ".");
  const out: string[] = [];
  for (const p of parts) {
    if (p === ".." || /[*?[\]{}]/.test(p)) break;
    out.push(p);
  }
  return out;
}

export function areasOverlap(a: string[], b: string[]): boolean {
  for (const x of a.map(areaPrefix)) for (const y of b.map(areaPrefix)) {
    const n = Math.min(x.length, y.length);
    if (x.slice(0, n).join("/") === y.slice(0, n).join("/")) return true;
  }
  return false;
}

const runsAlone = (f: Feature) => isValidatorSkill(f.skillName) || !f.fileAreas?.length;

/** Pending features that may start now, in plan order. Work stays inside the first unfinished milestone. */
export function pickRunnable(features: Feature[], runningIds: ReadonlySet<string>, limit: number): Feature[] {
  const milestone = features.find((f) => !isDone(f))?.milestone;
  const byId = new Map(features.map((f) => [f.id, f]));
  const merged = (id: string) => { const d = byId.get(id); return d?.status === "completed" && (!d.mergeStatus || d.mergeStatus === "merged"); };
  const active = features.filter((f) => runningIds.has(f.id));
  if (active.some(runsAlone)) return [];
  const picked: Feature[] = [];
  for (const f of features) {
    if (active.length + picked.length >= limit) break;
    if (f.status !== "pending" || runningIds.has(f.id) || f.milestone !== milestone) continue;
    if (!(f.dependsOn ?? []).every(merged)) continue;
    if (runsAlone(f)) {
      if (!active.length && !picked.length) picked.push(f);
      break; // later features wait, so a feature that runs alone is never starved
    }
    if ([...active, ...picked].some((x) => areasOverlap(x.fileAreas ?? [], f.fileAreas ?? []))) continue;
    picked.push(f);
  }
  return picked;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "feature";

export type MergeResult = { ok: true } | { ok: false; conflict: boolean; files: string[]; message: string };

export class MissionWorkspace {
  constructor(private mgr: WorktreeManager, private workingDirectory: string, private missionId: string, private log?: (m: string) => void) {}

  private async repo() {
    const top = await repoTopLevel(this.workingDirectory);
    if (!top) throw new WorktreeError("not_a_repo", `Parallel workers need a git repository: ${this.workingDirectory}`);
    return path.resolve(top);
  }

  /** The same subfolder inside a worktree, when the mission runs below the repository root. */
  private async inside(wtPath: string) {
    const rel = path.relative(realpathSync.native(await this.repo()), realpathSync.native(this.workingDirectory));
    return rel && !rel.startsWith("..") ? path.join(wtPath, rel) : wtPath;
  }

  /** Creates or reopens the worktree that holds the mission branch. */
  async ensureIntegration(known?: { branch?: string; path?: string }): Promise<{ branch: string; path: string; cwd: string }> {
    const repoRoot = await this.repo();
    const branch = known?.branch ?? `rigwell/mission-${slug(this.missionId)}`;
    const live = known?.path ? await this.mgr.get(known.path) : null;
    if (live) return { branch, path: live.path, cwd: await this.inside(live.path) };
    const exists = (await git(repoRoot, ["show-ref", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
    const wt = await this.mgr.create({ repoRoot, sessionId: this.missionId, branchMode: exists ? "existing" : "copy", branch, lifecycle: "persistent" });
    return { branch, path: wt.path, cwd: await this.inside(wt.path) };
  }

  /** A persistent worktree: automatic cleanup never removes it before its work is merged. */
  async createWorker(featureId: string, workerId: string, missionBranch: string): Promise<{ branch: string; path: string; cwd: string }> {
    const branch = `${missionBranch}-${slug(featureId)}-${workerId.slice(0, 8)}`;
    const wt = await this.mgr.create({ repoRoot: await this.repo(), sessionId: workerId, branchMode: "copy", branch, baseRef: missionBranch, lifecycle: "persistent" });
    return { branch, path: wt.path, cwd: await this.inside(wt.path) };
  }

  /** Merges one finished branch. A failed merge is undone and never resolved here. */
  async merge(integrationPath: string, branch: string, featureId: string): Promise<MergeResult> {
    if ((await git(integrationPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) await git(integrationPath, ["merge", "--abort"]);
    const hasIdentity = (await git(integrationPath, ["config", "user.email"])).stdout.trim();
    const identity = hasIdentity ? [] : ["-c", "user.name=Rigwell", "-c", "user.email=rigwell@localhost"];
    const r = await git(integrationPath, [...identity, "merge", "--no-ff", "--no-edit", "-m", `Merge mission feature ${featureId}`, branch]);
    if (r.code === 0) return { ok: true };
    const files = (await git(integrationPath, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((x) => x.trim()).filter(Boolean);
    if ((await git(integrationPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) await git(integrationPath, ["merge", "--abort"]);
    return { ok: false, conflict: files.length > 0, files, message: (r.stderr || r.stdout).trim().slice(0, 500) };
  }

  /** Removes a worktree after its work is safe. A failure only leaves a folder behind. */
  async removeWorktree(wtPath: string, deleteBranch: boolean) {
    try { await this.mgr.remove(wtPath, { deleteLocalBranch: deleteBranch }); }
    catch (e) { this.log?.(`[mission] worktree kept at ${wtPath}: ${(e as Error).message}`); }
  }
}

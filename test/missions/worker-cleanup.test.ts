// A finished worker's worktree can still be held by its session for a moment while the connection shuts down.
// Cleanup must wait for that hold to clear instead of giving up with "A live session is using this worktree".
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo } from "../e2e/helpers.ts";
import { MissionWorkspace } from "../../src/missions/parallel.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";

const repos: string[] = [], roots: string[] = [];
afterAll(() => { for (const r of repos) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); });

function tempRoot() { const r = mkdtempSync(join(tmpdir(), "rigwell-wt-cleanup-")); roots.push(r); return r; }
const gitOut = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function workspace(held: () => boolean) {
  const repo = makeRepo(); repos.push(repo);
  const mgr = new WorktreeManager({ root: tempRoot(), inUse: held });
  const ws = new MissionWorkspace(mgr, repo, "mis-cleanup");
  return { repo, mgr, ws };
}

describe("mission worker worktree cleanup", () => {
  test("removes a merged worker worktree and branch once its session lets go", async () => {
    let held = true;
    const { repo, mgr, ws } = workspace(() => held);
    const wt = await mgr.create({ repoRoot: repo, sessionId: "worker-1", branchMode: "copy", branch: "rigwell/mission-worker-1", lifecycle: "persistent" });
    // The worker connection releases the hold shortly after its session ends.
    const release = new Promise<void>((r) => setTimeout(() => { held = false; r(); }, 150));
    await ws.removeWorktree(wt.path, true);
    await release;
    expect(await mgr.get(wt.path)).toBeNull();
    expect(gitOut(repo, "branch", "--list", "rigwell/mission-worker-1")).toBe("");
  }, 15_000);

  test("never removes a worktree that still has uncommitted user work", async () => {
    const { repo, mgr, ws } = workspace(() => false);
    const wt = await mgr.create({ repoRoot: repo, sessionId: "worker-2", branchMode: "copy", branch: "rigwell/mission-worker-2", lifecycle: "persistent" });
    writeFileSync(join(wt.path, "uncommitted.txt"), "not committed\n");
    await ws.removeWorktree(wt.path, true);
    expect(await mgr.get(wt.path)).not.toBeNull();
    expect(gitOut(repo, "branch", "--list", "rigwell/mission-worker-2")).toContain("rigwell/mission-worker-2");
  }, 15_000);
});

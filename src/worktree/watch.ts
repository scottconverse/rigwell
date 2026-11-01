// HEAD watching (spec 18.6): watch each checkout's HEAD file (debounced 150 ms) and report branch changes.
import { watch, type FSWatcher } from "node:fs";
import { git, gitDirOf } from "./git.ts";

export interface BranchChange { worktreePath: string; branch: string | null; previousBranch: string | null }

export interface HeadWatcherOptions {
  debounceMs?: number;
  onChange: (c: BranchChange) => void;
  log?: (m: string) => void;
}

/** Watches the HEAD of any number of checkouts. A change that leaves the branch name the same is not reported. */
export class HeadWatcher {
  private watches = new Map<string, { fs: FSWatcher; last: string | null; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private o: HeadWatcherOptions) {}

  private async branchOf(dir: string): Promise<string | null> {
    return (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
  }

  async add(worktreePath: string): Promise<void> {
    if (this.watches.has(worktreePath)) return;
    const gitDir = await gitDirOf(worktreePath);
    const w: { fs: FSWatcher; last: string | null; timer?: ReturnType<typeof setTimeout> } = { last: await this.branchOf(worktreePath), fs: undefined as any };
    // Watch the git dir, not HEAD itself: git replaces HEAD with a rename, which would end a file watch.
    w.fs = watch(gitDir, (_ev, name) => {
      if (name && name !== "HEAD") return;
      clearTimeout(w.timer);
      w.timer = setTimeout(() => void this.check(worktreePath), this.o.debounceMs ?? 150);
    });
    w.fs.on("error", (e) => this.o.log?.(`[worktree] HEAD watch failed for ${worktreePath}: ${e.message}`));
    this.watches.set(worktreePath, w);
  }

  /** Compares the current branch with the last one seen and reports a change. Also callable directly (tests, polling). */
  async check(worktreePath: string): Promise<boolean> {
    const w = this.watches.get(worktreePath);
    if (!w) return false;
    const now = await this.branchOf(worktreePath).catch(() => w.last);
    if (now === w.last) return false;
    const previousBranch = w.last;
    w.last = now;
    this.o.onChange({ worktreePath, branch: now, previousBranch });
    return true;
  }

  remove(worktreePath: string) {
    const w = this.watches.get(worktreePath);
    if (!w) return;
    clearTimeout(w.timer);
    w.fs.close();
    this.watches.delete(worktreePath);
  }

  has(worktreePath: string) { return this.watches.has(worktreePath); }
  close() { for (const p of [...this.watches.keys()]) this.remove(p); }
}

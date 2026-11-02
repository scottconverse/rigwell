// Worktree manager (spec §18): create, list, status, remove, auto-delete.
// Per-worktree state lives in the worktree's git dir (never in the work tree):
//   rigwell-worktree.json      meta: session, repo, branch, lifecycle, last use
//   rigwell-setup-receipt.json head SHA, time, lifecycle, fingerprints of untracked files present after setup
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { CHECKOUT_TIMEOUT_MS, canonicalPath, git, gitDirOf, gitOk } from "./git.ts";
import { copyWorktreeIncludes, type IncludeResult } from "./include.ts";
import { CLEANUP_TIMEOUT_MS, SETUP_TIMEOUT_MS, runScript, type ScriptResult } from "./scripts.ts";
import { findProfile, type SetupProfile } from "./profiles.ts";

export type Lifecycle = "ephemeral" | "persistent";
export type WorktreeErrorCode =
  | "not_a_repo" | "root_branch" | "branch_occupied" | "branch_missing" | "dirty" | "in_use" | "reserved"
  | "not_managed" | "exists" | "git_failed" | "timeout" | "include_failed";

export class WorktreeError extends Error {
  constructor(public code: WorktreeErrorCode, message: string) { super(message); }
}

export interface WorktreeMeta {
  sessionId: string;
  repoRoot: string;
  branch: string;
  baseRef: string;
  lifecycle: Lifecycle;
  setupProfileId?: string;
  createdAt: number;
  lastUsedAt: number;
  pinned?: boolean;
  reserved?: boolean;
  /** True when the branch name was generated (eligible for rename after the title). */
  generatedBranch?: boolean;
}

export interface ManagedWorktree extends WorktreeMeta { path: string }

export interface Receipt {
  head: string;
  time: number;
  lifecycle: Lifecycle;
  untracked: { path: string; sha1: string }[];
}

export interface ManagerOptions {
  /** Root folder for worktrees. Must be absolute; a relative value is ignored (see `resolveRoot`). */
  root?: string;
  autoDeleteLimit?: number;
  /** A worktree used within this window is not auto-removed (default 30 min). */
  recentMs?: number;
  /** Is this repo folder trusted (allows repository profiles and cleanup scripts to run)? */
  isTrusted?: (repoRoot: string) => boolean;
  /** Paths with a live session. */
  inUse?: (worktreePath: string) => boolean;
  setupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  now?: () => number;
  log?: (m: string) => void;
  /** Called after a worktree is removed, whoever asked (cleanup, auto-delete, archive, housekeeping, failed start). */
  onRemoved?: (e: RemovedWorktree) => void;
  /** Trust bookkeeping for worktree folders (spec 18.1: mark trusted on create; 18.5: forget on removal). */
  trust?: { mark(p: string): void; forget(p: string): void };
}

export interface RemovedWorktree { path: string; sessionId: string; repoRoot: string; branch: string | null }

/** Absolute `worktreeDirectory` setting, else `<rigwell home>/worktrees`. A relative value is ignored with a warning. */
export function resolveRoot(setting: unknown, warn?: (m: string) => void): string {
  if (typeof setting === "string" && setting) {
    if (path.isAbsolute(setting)) return path.resolve(setting);
    warn?.(`worktreeDirectory must be an absolute path; ignoring ${JSON.stringify(setting)}`);
  }
  return path.join(rigwellHome(), "worktrees");
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");

/** `<root>/<last 8 chars of session id>/<repo folder name>` (spec §18.2). */
export function worktreePathFor(root: string, sessionId: string, repoRoot: string): string {
  return path.join(root, sanitize(sessionId.slice(-8)), sanitize(path.basename(repoRoot)));
}

export const BRANCH_PREFIX = "rigwell/";
const PAD_WORDS = ["work", "task", "tree"];

/** Prefix + slug of up to 5 words (padded to 3), whole name at most 32 chars. */
export function branchSlug(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  for (let i = 0; words.length < 3; i++) words.push(PAD_WORDS[i]!);
  return (BRANCH_PREFIX + words.join("-")).slice(0, 32).replace(/-+$/, "");
}

class Semaphore {
  private waiters: (() => void)[] = [];
  private n = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.n++;
    try { return await fn(); } finally { this.n--; this.waiters.shift()?.(); }
  }
}

export interface CreateOptions {
  repoRoot: string;
  sessionId: string;
  /** First prompt, used to name a generated branch. */
  prompt?: string;
  /** copy (default): new branch. existing: check out `branch`. */
  branchMode?: "copy" | "existing";
  /** copy: the new branch name (generated when absent). existing: the branch to check out. */
  branch?: string;
  baseRef?: string;
  lifecycle?: Lifecycle;
  setupProfileId?: string;
  /** Fetch the base branch (copy mode) or the branch (existing mode) from origin first. A failed fetch is not fatal. */
  pullFromOrigin?: boolean;
}

export interface CreatedWorktree extends ManagedWorktree {
  include: IncludeResult;
  autoDeleted: string[];
  /** Present when pullFromOrigin was asked: whether the fetch worked. */
  fetched?: boolean;
}

export interface WorktreeStatus {
  path: string;
  branch: string | null;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Everything git reports as changed (includes setup output). */
  changedFiles: string[];
  /** Changed files that are user work (not tracked setup output). */
  userChangedFiles: string[];
  dirty: boolean;
}

export interface DeletionInspection {
  path: string;
  branch: string | null;
  changedFiles: string[];
  userChangedFiles: string[];
  localOnlyCommits: string[];
}

export class WorktreeManager {
  readonly root: string;
  private o: Required<Pick<ManagerOptions, "autoDeleteLimit" | "recentMs" | "setupTimeoutMs" | "cleanupTimeoutMs">> & ManagerOptions;
  private creations = new Semaphore(4);
  private perRepo = new Map<string, Semaphore>();
  private removals = new Semaphore(2);
  private autoDeleting: Promise<string[]> | null = null;

  constructor(opts: ManagerOptions = {}) {
    this.root = opts.root ?? resolveRoot(undefined);
    this.o = { autoDeleteLimit: 15, recentMs: 30 * 60_000, setupTimeoutMs: SETUP_TIMEOUT_MS, cleanupTimeoutMs: CLEANUP_TIMEOUT_MS, ...opts };
  }

  private now() { return (this.o.now ?? Date.now)(); }

  // ---- create -------------------------------------------------------------------------

  async create(c: CreateOptions): Promise<CreatedWorktree> {
    const repoRoot = await this.requireRepo(c.repoRoot);
    const sem = this.perRepo.get(repoRoot) ?? new Semaphore(2);
    this.perRepo.set(repoRoot, sem);
    return await this.creations.run(() => sem.run(() => this.createNow({ ...c, repoRoot })));
  }

  private async requireRepo(dir: string): Promise<string> {
    const r = await git(dir, ["rev-parse", "--show-toplevel"]);
    if (r.code !== 0) throw new WorktreeError("not_a_repo", `Not a git repository: ${dir}`);
    const head = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (head.code !== 0) throw new WorktreeError("not_a_repo", "The repository has no commits yet");
    return path.resolve(r.stdout.trim());
  }

  private async createNow(c: CreateOptions & { repoRoot: string }): Promise<CreatedWorktree> {
    const { repoRoot } = c;
    const autoDeleted = await this.autoDelete().catch(() => [] as string[]);
    const wtPath = worktreePathFor(this.root, c.sessionId, repoRoot);
    if (existsSync(wtPath)) throw new WorktreeError("exists", `Worktree folder already exists: ${wtPath}`);
    mkdirSync(path.dirname(wtPath), { recursive: true });

    const lifecycle = c.lifecycle ?? "ephemeral";
    let fetched: boolean | undefined;
    let freshBase: string | undefined;
    if (c.pullFromOrigin) {
      const wanted = c.branchMode === "existing" ? c.branch : (c.baseRef ?? (await git(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim());
      const name = wanted?.replace(/^origin\//, "");
      if (name) {
        const f = await git(repoRoot, ["fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`], { timeoutMs: CHECKOUT_TIMEOUT_MS });
        fetched = f.code === 0;
        if (!fetched) this.o.log?.(`[worktree] fetch from origin failed, using the local base: ${f.stderr.trim()}`);
        else freshBase = `origin/${name}`;
      } else fetched = false;
    }
    let branch: string;
    let generated = false;
    let args: string[];
    let baseRef = c.baseRef ?? "HEAD";
    let baseBranch = "HEAD";
    if (freshBase && c.branchMode !== "existing") baseRef = freshBase; // a fetched base replaces the possibly stale local one

    if (c.branchMode === "existing") {
      if (!c.branch) throw new WorktreeError("branch_missing", "branch is required for existing mode");
      branch = c.branch;
      await this.assertNotRootBranch(repoRoot, branch);
      if ((await this.branchesCheckedOut(repoRoot)).has(branch)) throw new WorktreeError("branch_occupied", `Branch ${branch} is already checked out elsewhere`);
      const local = await git(repoRoot, ["show-ref", "--verify", "-q", `refs/heads/${branch}`]);
      if (local.code === 0) {
        args = ["worktree", "add", wtPath, branch];
        baseRef = branch;
      } else {
        const remote = (await gitOk(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${branch}`])).split("\n").filter(Boolean)[0];
        if (!remote) throw new WorktreeError("branch_missing", `No local or remote branch named ${branch}`);
        args = ["worktree", "add", "-b", branch, "--track", wtPath, remote];
        baseRef = remote;
      }
    } else {
      const base = await gitOk(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      baseBranch = base;
      if (c.branch) {
        branch = c.branch;
        if ((await git(repoRoot, ["show-ref", "--verify", "-q", `refs/heads/${branch}`])).code === 0) {
          throw new WorktreeError("branch_occupied", `Branch ${branch} already exists; use existing mode`);
        }
      } else {
        generated = true;
        const wanted = c.prompt ? branchSlug(c.prompt) : `${base === "HEAD" ? "detached" : base}-wt`;
        branch = await this.freeBranchName(repoRoot, wanted);
      }
      args = ["worktree", "add", "-b", branch, "--no-track", wtPath, baseRef];
    }

    const add = await git(repoRoot, args, { timeoutMs: CHECKOUT_TIMEOUT_MS });
    if (add.code !== 0) {
      await this.rollback(repoRoot, wtPath, c.branchMode === "existing" ? undefined : branch);
      if (add.timedOut) throw new WorktreeError("timeout", "git worktree add timed out after 10 minutes; rolled back");
      throw new WorktreeError("git_failed", `git worktree add failed: ${add.stderr.trim()}`);
    }

    let include: IncludeResult;
    try {
      include = await copyWorktreeIncludes(repoRoot, wtPath);
    } catch (e) {
      await this.rollback(repoRoot, wtPath, c.branchMode === "existing" ? undefined : branch);
      throw new WorktreeError("include_failed", `.worktreeinclude copy failed: ${(e as Error).message}`);
    }

    const t = this.now();
    const meta: WorktreeMeta = {
      sessionId: c.sessionId, repoRoot, branch, baseRef: baseRef === "HEAD" && baseBranch !== "HEAD" ? baseBranch : baseRef, lifecycle, setupProfileId: c.setupProfileId,
      createdAt: t, lastUsedAt: t, generatedBranch: generated,
    };
    this.writeMeta(await gitDirOf(wtPath), meta);
    try { this.o.trust?.mark(wtPath); } catch (e) { this.o.log?.(`[worktree] could not mark ${wtPath} trusted: ${(e as Error).message}`); }
    return { ...meta, path: wtPath, include, autoDeleted, ...(fetched !== undefined ? { fetched } : {}) };
  }

  private async rollback(repoRoot: string, wtPath: string, newBranch?: string) {
    await git(repoRoot, ["worktree", "remove", "--force", wtPath]);
    rmSync(wtPath, { recursive: true, force: true });
    await git(repoRoot, ["worktree", "prune"]);
    if (newBranch) await git(repoRoot, ["branch", "-D", newBranch]);
    this.removeEmptyGroup(wtPath);
  }

  private async freeBranchName(repoRoot: string, wanted: string): Promise<string> {
    for (let i = 1; i <= 100; i++) {
      const name = i === 1 ? wanted : `${wanted}-${i}`;
      if ((await git(repoRoot, ["show-ref", "--verify", "-q", `refs/heads/${name}`])).code !== 0) return name;
    }
    throw new WorktreeError("git_failed", `No free branch name for ${wanted} after 100 tries`);
  }

  private async assertNotRootBranch(repoRoot: string, branch: string) {
    const current = (await git(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    const origin = (await git(repoRoot, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "");
    if (branch === current || (origin && branch === origin)) throw new WorktreeError("root_branch", `${branch} is the repository's own branch; pick another`);
  }

  private async branchesCheckedOut(repoRoot: string): Promise<Set<string>> {
    const out = await gitOk(repoRoot, ["worktree", "list", "--porcelain"]);
    return new Set(out.split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length)));
  }

  // ---- setup --------------------------------------------------------------------------

  /** Resolves the profile and whether it may run. Repository profiles need a trusted repo. */
  resolveProfile(repoRoot: string, id: string): { profile?: SetupProfile; runnable: boolean; reason?: string } {
    const profile = findProfile(repoRoot, id);
    if (!profile) return { runnable: false, reason: `No setup profile named ${id}` };
    if (profile.source === "repository" && !this.trusted(repoRoot)) {
      return { profile, runnable: false, reason: "Repository setup profiles run only in a trusted folder" };
    }
    return { profile, runnable: true };
  }

  private trusted(repoRoot: string) { return this.o.isTrusted?.(repoRoot) ?? false; }

  /** Runs the profile's script in the worktree, then writes the receipt. Always writes the receipt. */
  async runSetup(wt: ManagedWorktree, profile: SetupProfile | undefined, onProgress?: (text: string) => void): Promise<ScriptResult | null> {
    let result: ScriptResult | null = null;
    if (profile?.script) {
      result = await runScript({ script: profile.script, cwd: wt.path, repoRoot: wt.repoRoot, timeoutMs: this.o.setupTimeoutMs, onProgress });
    }
    await this.writeReceipt(wt);
    return result;
  }

  private async writeReceipt(wt: { path: string; lifecycle: Lifecycle }) {
    const dir = await gitDirOf(wt.path);
    const receipt: Receipt = {
      head: await gitOk(wt.path, ["rev-parse", "HEAD"]),
      time: this.now(), lifecycle: wt.lifecycle, untracked: await this.fingerprintUntracked(wt.path),
    };
    writeFileSync(path.join(dir, "rigwell-setup-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }

  private async untrackedFiles(wtPath: string): Promise<string[]> {
    const out = await gitOk(wtPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return out.split("\0").filter(Boolean);
  }

  private async fingerprintUntracked(wtPath: string) {
    return (await this.untrackedFiles(wtPath)).map((p) => ({ path: p, sha1: sha1File(path.join(wtPath, p)) }));
  }

  // ---- list and status ----------------------------------------------------------------

  /** Managed worktrees under the root (optionally for one repo), newest use first. */
  async list(filter?: { repoRoot?: string }): Promise<ManagedWorktree[]> {
    const out: ManagedWorktree[] = [];
    if (!existsSync(this.root)) return out;
    for (const group of readdirSync(this.root)) {
      const gdir = path.join(this.root, group);
      let kids: string[];
      try { kids = statSync(gdir).isDirectory() ? readdirSync(gdir) : []; } catch { continue; }
      for (const k of kids) {
        const p = path.join(gdir, k);
        if (!existsSync(path.join(p, ".git"))) continue;
        const meta = await this.readMetaFor(p);
        if (!meta) continue;
        if (filter?.repoRoot && canonicalPath(meta.repoRoot) !== canonicalPath(filter.repoRoot)) continue;
        out.push({ ...meta, path: p });
      }
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async get(wtPath: string): Promise<ManagedWorktree | null> {
    const p = path.resolve(wtPath);
    const meta = await this.readMetaFor(p);
    return meta && p.startsWith(this.root + path.sep) ? { ...meta, path: p } : null;
  }

  /** The managed worktree containing `dir`, if any (a session adopts it). */
  async containing(dir: string): Promise<ManagedWorktree | null> {
    const rel = path.relative(this.root, path.resolve(dir));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.length < 2) return null;
    return await this.get(path.join(this.root, parts[0]!, parts[1]!));
  }

  private async readMetaFor(wtPath: string): Promise<WorktreeMeta | null> {
    try {
      const dir = await gitDirOf(wtPath);
      return JSON.parse(readFileSync(path.join(dir, "rigwell-worktree.json"), "utf8")) as WorktreeMeta;
    } catch { return null; }
  }

  private writeMeta(gitDir: string, meta: WorktreeMeta) {
    writeFileSync(path.join(gitDir, "rigwell-worktree.json"), JSON.stringify(meta, null, 2) + "\n");
  }

  async updateMeta(wtPath: string, patch: Partial<WorktreeMeta>) {
    const dir = await gitDirOf(wtPath);
    const cur = await this.readMetaFor(wtPath);
    if (!cur) throw new WorktreeError("not_managed", `Not a managed worktree: ${wtPath}`);
    this.writeMeta(dir, { ...cur, ...patch });
  }

  async touch(wtPath: string) { await this.updateMeta(wtPath, { lastUsedAt: this.now() }); }

  private async readReceipt(wtPath: string): Promise<Receipt | null> {
    try { return JSON.parse(readFileSync(path.join(await gitDirOf(wtPath), "rigwell-setup-receipt.json"), "utf8")) as Receipt; }
    catch { return null; }
  }

  /** Changed files via porcelain status. Untracked entries matching the receipt count as setup output. */
  private async changes(wtPath: string): Promise<{ changed: string[]; user: string[]; setupOnly: string[] }> {
    const out = (await git(wtPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    const entries = out.split("\0").filter(Boolean);
    const receipt = await this.readReceipt(wtPath);
    const known = new Map((receipt?.untracked ?? []).map((u) => [u.path, u.sha1]));
    const changed: string[] = [], user: string[] = [], setupOnly: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const code = e.slice(0, 2);
      const file = e.slice(3);
      if (code[0] === "R" || code[0] === "C") i++; // rename source follows as a separate entry
      changed.push(file);
      if (code === "??" && known.get(file) === sha1File(path.join(wtPath, file))) setupOnly.push(file);
      else user.push(file);
    }
    return { changed, user, setupOnly };
  }

  async status(wtPath: string): Promise<WorktreeStatus> {
    const ch = await this.changes(wtPath);
    const branchName = (await git(wtPath, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
    const { upstream, ahead, behind } = await this.divergence(wtPath);
    return {
      path: wtPath, branch: branchName, head: await gitOk(wtPath, ["rev-parse", "HEAD"]), upstream, ahead, behind,
      changedFiles: ch.changed, userChangedFiles: ch.user, dirty: ch.user.length > 0,
    };
  }

  /** Ahead/behind of HEAD against its upstream, else against the recorded base ref, else 0/0. */
  async divergence(wtPath: string, against?: string): Promise<{ upstream: string | null; ahead: number; behind: number }> {
    let target = against ?? (await git(wtPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
    let upstream: string | null = target || null;
    if (!target) {
      const meta = await this.readMetaFor(wtPath);
      target = meta?.baseRef ?? "";
    }
    if (!target) return { upstream, ahead: 0, behind: 0 };
    const r = await git(wtPath, ["rev-list", "--left-right", "--count", `HEAD...${target}`]);
    if (r.code !== 0) return { upstream, ahead: 0, behind: 0 };
    const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
    return { upstream, ahead: a ?? 0, behind: b ?? 0 };
  }

  /** Commits on the branch found on no other branch and no remote. */
  async localOnlyCommits(wtPath: string, branch: string | null): Promise<string[]> {
    if (!branch) return [];
    const r = await git(wtPath, ["rev-list", branch, `--not`, `--exclude=${branch}`, "--branches", "--remotes"]);
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  async inspectDeletion(wtPath: string): Promise<DeletionInspection> {
    const ch = await this.changes(wtPath);
    const branch = (await git(wtPath, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
    return { path: wtPath, branch, changedFiles: ch.changed, userChangedFiles: ch.user, localOnlyCommits: await this.localOnlyCommits(wtPath, branch) };
  }

  // ---- remove -------------------------------------------------------------------------

  async remove(wtPath: string, opts: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean; force?: boolean } = {}) {
    return await this.removals.run(() => this.removeNow(wtPath, opts));
  }

  private async removeNow(wtPath: string, opts: { deleteLocalBranch?: boolean; deleteRemoteBranch?: boolean; force?: boolean }) {
    const wt = await this.get(wtPath);
    if (!wt) throw new WorktreeError("not_managed", `Not a managed worktree: ${wtPath}`);
    if (wt.reserved && !opts.force) throw new WorktreeError("reserved", "The worktree is reserved");
    if (this.o.inUse?.(wt.path) && !opts.force) throw new WorktreeError("in_use", "A live session is using this worktree");
    const insp = await this.inspectDeletion(wt.path);
    if (insp.userChangedFiles.length > 0 && !opts.force) {
      throw new WorktreeError("dirty", `Uncommitted work: ${insp.userChangedFiles.slice(0, 5).join(", ")}`);
    }
    const profile = wt.setupProfileId ? findProfile(wt.repoRoot, wt.setupProfileId) : undefined;
    const cleanupRun = profile?.cleanupScript && (profile.source === "local" || this.trusted(wt.repoRoot));
    let cleanup: ScriptResult | null = null;
    if (cleanupRun) {
      cleanup = await runScript({ script: profile!.cleanupScript!, cwd: wt.path, repoRoot: wt.repoRoot, timeoutMs: this.o.cleanupTimeoutMs });
    }
    // Setup leftovers need --force; user work only gets here with force.
    const needForce = insp.changedFiles.length > 0;
    const rm = await git(wt.repoRoot, ["worktree", "remove", ...(needForce ? ["--force"] : []), wt.path]);
    if (rm.code !== 0) throw new WorktreeError("git_failed", `git worktree remove failed: ${rm.stderr.trim()}`);
    await git(wt.repoRoot, ["worktree", "prune"]);
    this.removeEmptyGroup(wt.path);
    try { this.o.trust?.forget(wt.path); } catch { /* best effort */ }
    let branchDeleted = false;
    if (opts.deleteLocalBranch && insp.branch) branchDeleted = (await git(wt.repoRoot, ["branch", "-D", insp.branch])).code === 0;
    let remoteDeleted = false;
    if (opts.deleteRemoteBranch && insp.branch) remoteDeleted = (await git(wt.repoRoot, ["push", "origin", "--delete", insp.branch])).code === 0;
    try { this.o.onRemoved?.({ path: wt.path, sessionId: wt.sessionId, repoRoot: wt.repoRoot, branch: insp.branch }); } catch { /* listener errors never fail a removal */ }
    return { path: wt.path, branch: insp.branch, branchDeleted, remoteDeleted, cleanup };
  }

  private removeEmptyGroup(wtPath: string) {
    try { rmdirSync(path.dirname(wtPath)); } catch { /* not empty or gone */ }
  }

  // ---- auto-delete --------------------------------------------------------------------

  /**
   * When there are more ephemeral worktrees than the limit, removes least-recently-used ones.
   * Skips pinned, reserved, in-use and recently used worktrees and any with uncommitted work or
   * local-only commits. One pass at a time. Returns the removed paths.
   */
  async autoDelete(): Promise<string[]> {
    if (this.autoDeleting) return await this.autoDeleting;
    this.autoDeleting = this.autoDeleteNow().finally(() => { this.autoDeleting = null; });
    return await this.autoDeleting;
  }

  private async autoDeleteNow(): Promise<string[]> {
    const eph = (await this.list()).filter((w) => w.lifecycle === "ephemeral");
    let excess = eph.length - this.o.autoDeleteLimit;
    const removed: string[] = [];
    if (excess <= 0) return removed;
    const lru = [...eph].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const w of lru) {
      if (excess <= 0) break;
      if (w.pinned || w.reserved || this.o.inUse?.(w.path)) continue;
      if (this.now() - w.lastUsedAt < this.o.recentMs) continue;
      const insp = await this.inspectDeletion(w.path);
      if (insp.userChangedFiles.length > 0 || insp.localOnlyCommits.length > 0) continue;
      try {
        await this.remove(w.path);
        removed.push(w.path);
        excess--;
      } catch (e) { this.o.log?.(`[worktree] auto-delete skipped ${w.path}: ${(e as Error).message}`); }
    }
    return removed;
  }

  // ---- rename after title, archive ---------------------------------------------------

  /**
   * Spec 18.2: once the session has a generated title, rename a generated branch to a slug of the title, unless the
   * branch has commits found nowhere else, has an upstream, was picked by the user, or was already renamed.
   * Returns the new branch name, or null when nothing changed.
   */
  async renameGeneratedBranch(wtPath: string, title: string): Promise<string | null> {
    const wt = await this.get(wtPath);
    if (!wt || !wt.generatedBranch || !title.trim()) return null;
    const current = (await git(wt.path, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (!current || current !== wt.branch) return null; // the user switched branches
    if ((await git(wt.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).code === 0) return null;
    if ((await this.localOnlyCommits(wt.path, current)).length > 0) return null;
    const wanted = branchSlug(title);
    if (wanted === current) { await this.updateMeta(wt.path, { generatedBranch: false }); return null; }
    const next = await this.freeBranchName(wt.repoRoot, wanted);
    const r = await git(wt.path, ["branch", "-m", current, next]);
    if (r.code !== 0) { this.o.log?.(`[worktree] branch rename failed: ${r.stderr.trim()}`); return null; }
    await this.updateMeta(wt.path, { branch: next, generatedBranch: false });
    return next;
  }

  /** The managed worktree that belongs to a session, if any. */
  async forSession(sessionId: string): Promise<ManagedWorktree | null> {
    return (await this.list()).find((w) => w.sessionId === sessionId) ?? null;
  }

  /** True when removing the worktree would lose nothing and nothing else needs it. */
  async isSafeToRemove(w: ManagedWorktree): Promise<boolean> {
    if (w.pinned || w.reserved || this.o.inUse?.(w.path)) return false;
    const insp = await this.inspectDeletion(w.path);
    return insp.userChangedFiles.length === 0 && insp.localOnlyCommits.length === 0;
  }

  /**
   * Spec 18.5: archiving a session that owns an ephemeral worktree removes it if safe.
   * Returns the removed path, or null when the worktree was kept.
   */
  async removeForArchivedSession(sessionId: string): Promise<string | null> {
    const w = await this.forSession(sessionId);
    if (!w || w.lifecycle !== "ephemeral") return null;
    if (!(await this.isSafeToRemove(w))) return null;
    try { await this.remove(w.path); return w.path; }
    catch (e) { this.o.log?.(`[worktree] archive removal skipped ${w.path}: ${(e as Error).message}`); return null; }
  }

  /** Time of the worktree's setup receipt (housekeeping orphan rule). */
  async receiptTime(wtPath: string): Promise<number | null> { return (await this.readReceipt(wtPath))?.time ?? null; }

  /** Marks a session's worktree as just kept by the user, so auto-delete leaves it alone for the recent window. */
  async keep(wtPath: string) { await this.touch(wtPath); }
}

function sha1File(file: string): string {
  try { return createHash("sha1").update(readFileSync(file)).digest("hex"); } catch { return ""; }
}

// Glue between the connection (initialize_session and protocol methods) and the worktree manager.
// Keeps src/daemon/connection.ts changes small. Protocol methods are `rigwell.<name>` (snake_case):
//   list_managed_worktrees, get_worktree_status, inspect_worktree_deletion, cleanup_worktree,
//   list_git_branches, checkout_git_branch, get_git_branch_divergence, git_commit, git_push, create_pr, get_pr_status
import path from "node:path";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import type { RigwellSettings } from "../storage/settings.ts";
import { WorktreeError, WorktreeManager, resolveRoot, type Lifecycle, type ManagedWorktree } from "./manager.ts";
import { checkoutBranch, commit, listBranches, push } from "./actions.ts";
import { createPr, hasOpenPr, prStatus } from "./pr.ts";
import { canonicalPath, repoTopLevel } from "./git.ts";
import { deleteLocalProfile, listProfiles, readProfileIndex, setLastUsedProfile, type SetupProfile } from "./profiles.ts";
import { forgetTrusted, markTrusted } from "./trust.ts";
import { HeadWatcher } from "./watch.ts";
import { Housekeeper } from "./housekeeping.ts";
import { findSession } from "../storage/transcript.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { loadSettings } from "../storage/settings.ts";
import { rigwellHome } from "../storage/paths.ts";

/** Worktrees with a live session in this process (path -> session id); auto-delete and remove skip them. */
const active = new Map<string, string>();
/**
 * Key for `active`. Windows paths compare case-insensitively and may arrive as 8.3 short names, forward slashes or a
 * different drive-letter case from the one the worktree was created with, so the key is the canonical lower-cased path
 * there. Elsewhere the path is used as given.
 */
export const activeKey = (p: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? (process.platform === "win32" ? canonicalPath(p) : path.win32.resolve(p)).replace(/\//g, "\\").toLowerCase() : p;
export const releaseWorktree = (p: string) => { active.delete(activeKey(p)); heads.remove(p); };

// ---- notifications (spec 18.5 and 18.6): the daemon subscribes and broadcasts to its clients ----
// Wire names: rigwell.worktree.removed {worktreePath, sessionId, repoRoot, branch}
//             rigwell.worktree.branch_changed {worktreePath, sessionId?, branch, previousBranch}
export type WorktreeNotifier = (method: "worktree.removed" | "worktree.branch_changed", params: Record<string, unknown>) => void;
const listeners = new Set<WorktreeNotifier>();
export function onWorktreeNotification(fn: WorktreeNotifier): () => void { listeners.add(fn); return () => void listeners.delete(fn); }
const emit: WorktreeNotifier = (m, p) => { for (const l of listeners) { try { l(m, p); } catch { /* a listener never breaks git work */ } } };

const heads = new HeadWatcher({
  onChange: (c) => {
    emit("worktree.branch_changed", { worktreePath: c.worktreePath, sessionId: active.get(c.worktreePath), branch: c.branch, previousBranch: c.previousBranch });
    if (c.branch) void new WorktreeManager({ root: path.dirname(path.dirname(c.worktreePath)) }).updateMeta(c.worktreePath, { branch: c.branch }).catch(() => {});
  },
});
/** Test and shutdown hook: stops every HEAD watch. */
export const closeHeadWatchers = () => heads.close();

export function managerFor(s: RigwellSettings, log?: (m: string) => void): WorktreeManager {
  const trusted = new Set(Object.keys(s.trustedFolders ?? {}).flatMap((p) => [path.resolve(p), canonicalPath(p)]));
  const limit = typeof s.worktreeAutoDeleteLimit === "number" && s.worktreeAutoDeleteLimit >= 0 ? s.worktreeAutoDeleteLimit : 15;
  return new WorktreeManager({
    root: resolveRoot(s.worktreeDirectory, log), autoDeleteLimit: limit, log,
    isTrusted: (repo) => trusted.has(path.resolve(repo)) || trusted.has(canonicalPath(repo)),
    inUse: (p) => active.has(activeKey(p)),
    trust: { mark: markTrusted, forget: forgetTrusted },
    hasOpenPr: (w) => hasOpenPr(w),
    onRemoved: (e) => { heads.remove(e.path); active.delete(activeKey(e.path)); emit("worktree.removed", { worktreePath: e.path, sessionId: e.sessionId, repoRoot: e.repoRoot, branch: e.branch }); },
  });
}

/** Starts the 5-minute housekeeping timer for the daemon. Returns a stop function. */
export function startWorktreeHousekeeping(opts: { log?: (m: string) => void } = {}): { stop(): void; tick(): ReturnType<Housekeeper["tick"]> } {
  const hk = new Housekeeper({ manager: () => managerFor(userSettings(), opts.log), log: opts.log });
  hk.start();
  return { stop: () => hk.stop(), tick: () => hk.tick() };
}

const userSettings = () => loadSettings({ cwd: rigwellHome() }).settings;

/**
 * A session was archived: remove its ephemeral worktree when that loses nothing (spec 18.5 housekeeping).
 * The archive_session method calls this after it writes `archivedAt`. Returns the removed path or null.
 */
export async function onSessionArchived(sessionId: string, settings: RigwellSettings = userSettings(), log?: (m: string) => void): Promise<string | null> {
  return await managerFor(settings, log).removeForArchivedSession(sessionId);
}

/** The session got its generated title: rename a generated branch (spec 18.2) and keep session settings in step. */
export async function onSessionTitleUpdated(sessionId: string, title: string, settings: RigwellSettings = userSettings(), log?: (m: string) => void): Promise<string | null> {
  const mgr = managerFor(settings, log);
  const wt = await mgr.forSession(sessionId);
  if (!wt) return null;
  const next = await mgr.renameGeneratedBranch(wt.path, title);
  if (next) {
    const files = findSession(sessionId);
    const cur = files ? readSessionSettings(files) : null;
    if (files && cur?.worktree && typeof cur.worktree === "object") updateSessionSettings(files, { worktree: { ...(cur.worktree as object), branch: next } });
    await heads.check(wt.path); // report now; the file watch would also catch it after its debounce
  }
  return next;
}

export interface WorktreeRequest {
  enabled: boolean;
  branch?: string;
  branchMode?: "copy" | "existing";
  baseRef?: string;
  lifecycle?: Lifecycle;
  setupProfile?: string;
  /** First prompt, used to name the generated branch. */
  prompt?: string;
  pullFromOrigin?: boolean;
}

function parseRequest(raw: unknown, s: RigwellSettings): WorktreeRequest | null {
  const bad = (m: string) => new RpcError(ErrorCodes.INVALID_PARAMS, m);
  if (raw === undefined || raw === null) return s.runInWorktree === true ? { enabled: true } : null;
  if (raw === true) return { enabled: true };
  if (raw === false) return null;
  if (typeof raw !== "object") throw bad("worktree must be an object");
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return null;
  const str = (k: string) => (r[k] === undefined ? undefined : typeof r[k] === "string" && r[k] ? (r[k] as string) : (() => { throw bad(`worktree.${k} must be a non-empty string`); })());
  const mode = str("branchMode");
  if (mode !== undefined && mode !== "copy" && mode !== "existing") throw bad("worktree.branchMode must be copy or existing");
  const life = str("lifecycle");
  if (life !== undefined && life !== "ephemeral" && life !== "persistent") throw bad("worktree.lifecycle must be ephemeral or persistent");
  return { enabled: true, branch: str("branch"), branchMode: mode as any, baseRef: str("baseRef"), lifecycle: life as Lifecycle, setupProfile: str("setupProfile"), prompt: str("prompt"), pullFromOrigin: r.pullFromOrigin === true };
}

export interface SessionWorktree {
  manager: WorktreeManager;
  info: ManagedWorktree;
  /** The session's working folder inside the worktree (same relative folder as the request cwd). */
  cwd: string;
  adopted: boolean;
  profile?: SetupProfile;
  profileSkipped?: string;
}

function toWorktreeError(e: unknown): never {
  if (e instanceof WorktreeError) throw new RpcError(e.code === "exists" || e.code === "branch_occupied" ? ErrorCodes.CONFLICT : ErrorCodes.INVALID_PARAMS, e.message, { code: e.code });
  throw e;
}

/** Creates (or adopts) the worktree for a new session. Returns null when no worktree is wanted. */
export async function startSessionWorktree(raw: unknown, cwd: string, sessionId: string, s: RigwellSettings, log?: (m: string) => void): Promise<SessionWorktree | null> {
  const manager = managerFor(s, log);
  const req = parseRequest(raw, s);
  if (!req) {
    const adopted = await manager.containing(cwd);
    if (!adopted) return null;
    active.set(activeKey(adopted.path), sessionId);
    void heads.add(adopted.path).catch(() => {});
    return { manager, info: adopted, cwd, adopted: true };
  }
  const top = await repoTopLevel(cwd);
  if (!top) throw new RpcError(ErrorCodes.INVALID_PARAMS, "worktree requires cwd to be inside a git repository");
  try {
    const info = await manager.create({
      repoRoot: top, sessionId, prompt: req.prompt, branchMode: req.branchMode, branch: req.branch,
      baseRef: req.baseRef, lifecycle: req.lifecycle, setupProfileId: req.setupProfile, pullFromOrigin: req.pullFromOrigin,
    });
    active.set(activeKey(info.path), sessionId);
    void heads.add(info.path).catch(() => {});
    if (req.setupProfile) { try { setLastUsedProfile(top, req.setupProfile); } catch { /* the index is a convenience */ } }
    const rel = path.relative(top, canonicalPath(cwd));
    const out: SessionWorktree = { manager, info, cwd: rel ? path.join(info.path, rel) : info.path, adopted: false };
    if (req.setupProfile) {
      const r = manager.resolveProfile(info.repoRoot, req.setupProfile);
      if (r.runnable) out.profile = r.profile;
      else out.profileSkipped = r.reason;
    }
    return out;
  } catch (e) {
    toWorktreeError(e);
  }
}

/** Removes a worktree created for a session that failed to start (profile cleanup runs first). */
export async function discardSessionWorktree(w: SessionWorktree): Promise<void> {
  releaseWorktree(w.info.path);
  if (w.adopted) return;
  await w.manager.remove(w.info.path, { force: true, deleteLocalBranch: w.info.baseRef !== w.info.branch }).catch(() => {});
}

/** What goes into session settings under `worktree`. */
export function worktreeSettings(w: SessionWorktree) {
  return {
    path: w.info.path, branch: w.info.branch, baseRef: w.info.baseRef, repoRoot: w.info.repoRoot,
    lifecycle: w.info.lifecycle, ...(w.info.setupProfileId ? { setupProfileId: w.info.setupProfileId } : {}), adopted: w.adopted,
  };
}

/** Runs the setup profile (if any) and the receipt. Progress goes out as setup_step_progress notifications. */
export async function runSessionSetup(w: SessionWorktree, notify: (n: Record<string, unknown>) => void) {
  if (w.adopted) return undefined;
  const progress = (kind: string) => (text: string) => notify({ type: "setup_step_progress", kind, text });
  const result = await w.manager.runSetup(w.info, w.profile, progress("setup_script"));
  return {
    profileId: w.profile?.id, skipped: w.profileSkipped,
    ...(result ? { ok: result.ok, exitCode: result.code, timedOut: result.timedOut, output: result.output } : {}),
    ...(w.profile?.initialPrompt && (!result || result.ok) ? { initialPrompt: w.profile.initialPrompt } : {}),
  };
}

export interface MethodContext {
  /** The connection's session working folder, when it has a session. */
  cwd?: string;
  settings: () => RigwellSettings;
  log?: (m: string) => void;
  /** The connection's request_permission to its client; absent when nobody can answer (a headless run). */
  requestPermission?: (params: Record<string, unknown>) => Promise<unknown>;
}

const need = (p: Record<string, unknown>, k: string): string => {
  if (typeof p[k] !== "string" || !p[k]) throw new RpcError(ErrorCodes.INVALID_PARAMS, `${k} is required`);
  return p[k] as string;
};

/** Handles worktree protocol methods. `handled: false` means the method is not ours. */
export async function handleWorktreeMethod(method: string, p: Record<string, unknown>, ctx: MethodContext): Promise<{ handled: boolean; result?: unknown }> {
  const target = () => (typeof p.worktreePath === "string" && p.worktreePath ? path.resolve(p.worktreePath) : ctx.cwd ?? need(p, "worktreePath"));
  const mgr = () => managerFor(ctx.settings(), ctx.log);
  const ok = (result: unknown) => ({ handled: true, result });
  try {
    switch (method) {
      case "list_managed_worktrees": {
        const worktrees = await mgr().list(typeof p.repoRoot === "string" ? { repoRoot: p.repoRoot } : undefined);
        return ok({ worktrees });
      }
      case "list_worktree_setup_profiles": {
        const repoRoot = path.resolve(need(p, "repoRoot"));
        return ok({ profiles: listProfiles(repoRoot).map((x) => ({ id: x.id, name: x.name, source: x.source, hasScript: !!x.script, hasCleanup: !!x.cleanupScript })), lastUsedProfileId: readProfileIndex(repoRoot).lastUsedProfileId });
      }
      case "delete_worktree_setup_profile": return ok({ deleted: deleteLocalProfile(path.resolve(need(p, "repoRoot")), need(p, "profileId")) });
      case "get_worktree_status": return ok({ status: await mgr().status(target()) });
      case "inspect_worktree_deletion": return ok(await mgr().inspectDeletion(path.resolve(need(p, "worktreePath"))));
      case "cleanup_worktree": {
        // Answer the live-session case before any subprocess work, so it never waits on one.
        if (p.force !== true && active.has(activeKey(need(p, "worktreePath")))) toWorktreeError(new WorktreeError("in_use", "A live session is using this worktree"));
        const r = await mgr().remove(path.resolve(need(p, "worktreePath")), {
          deleteLocalBranch: p.deleteLocalBranch === true, deleteRemoteBranch: p.deleteRemoteBranch === true, force: p.force === true,
        });
        releaseWorktree(r.path);
        return ok({ removed: true, path: r.path, branch: r.branch, branchDeleted: r.branchDeleted, remoteDeleted: r.remoteDeleted });
      }
      case "list_git_branches": return ok(await listBranches(target()));
      case "get_git_branch_divergence": {
        const d = await mgr().divergence(target(), typeof p.against === "string" ? p.against : undefined);
        return ok(d);
      }
      case "checkout_git_branch": {
        const resolve = p.resolve === "stash" || p.resolve === "commit" ? { mode: p.resolve as "stash" | "commit", message: typeof p.message === "string" ? p.message : undefined } : undefined;
        const r = await checkoutBranch(target(), need(p, "branch"), resolve);
        return ok(r.ok ? r : { ok: false, status: "needs_resolution", changedFiles: r.changedFiles });
      }
      case "git_commit": return ok(await commit(target(), need(p, "message")));
      case "git_push": return ok(await push(target()));
      case "create_pr": {
        const wt = target();
        const opt = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
        const m = mgr();
        const meta = await m.get(wt).catch(() => null);
        const r = await createPr(wt, { title: opt("title"), body: opt("body"), base: opt("base"), draft: p.draft === true }, ctx.requestPermission, { fallbackBase: meta?.baseRef });
        if (r.created && meta) await m.updateMeta(wt, { pr: { number: r.number, url: r.url } }).catch(() => {});
        return ok(r);
      }
      case "get_pr_status": return ok(await prStatus(target()));
      default: return { handled: false };
    }
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof WorktreeError) toWorktreeError(e);
    throw new RpcError(ErrorCodes.INTERNAL_ERROR, (e as Error).message);
  }
}

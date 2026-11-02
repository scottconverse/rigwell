// Gap-fix tests for worktrees: origin fetch, branch rename, HEAD watching, housekeeping, archive removal,
// removal broadcast, trusted folders, profile index. Temp repos and a local bare repo as origin.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import { HeadWatcher } from "../../src/worktree/watch.ts";
import { Housekeeper, type HousekeepingHost, type SessionRecord } from "../../src/worktree/housekeeping.ts";
import { deleteLocalProfile, findProfile, readProfileIndex, saveLocalProfile, setLastUsedProfile } from "../../src/worktree/profiles.ts";
import { closeHeadWatchers, managerFor, onSessionArchived, onWorktreeNotification } from "../../src/worktree/connect.ts";
import { forgetTrusted, markTrusted } from "../../src/worktree/trust.ts";
import { makeGitRepo, sh, tmp } from "./util.ts";

let home: string;
beforeEach(() => {
  home = tmp("home");
  process.env.RIGWELL_HOME = home;
});

/** A repo whose origin is a local bare repository. */
function repoWithOrigin() {
  const repo = makeGitRepo();
  const bare = tmp("bare");
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(repo, "remote", "add", "origin", bare);
  sh(repo, "push", "-q", "-u", "origin", "main");
  return { repo, bare };
}

/** Adds a commit to origin/main through a second clone. */
function advanceOrigin(bare: string): string {
  const other = tmp("clone");
  sh(other, "clone", "-q", bare, ".");
  writeFileSync(join(other, "new.txt"), "from origin\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "remote work");
  sh(other, "push", "-q", "origin", "main");
  return sh(other, "rev-parse", "HEAD");
}

describe("pullFromOrigin", () => {
  test("fetches the base and branches from the fresh origin tip", async () => {
    const { repo, bare } = repoWithOrigin();
    const tip = advanceOrigin(bare);
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-00000001", prompt: "pull test", pullFromOrigin: true });
    expect(wt.fetched).toBe(true);
    expect(sh(wt.path, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(join(wt.path, "new.txt"), "utf8")).toBe("from origin\n");
    expect(wt.baseRef).toBe("origin/main");
    // the repo's own main is untouched
    expect(sh(repo, "rev-parse", "main")).not.toBe(tip);
  });
  test("without the flag the base stays local", async () => {
    const { repo, bare } = repoWithOrigin();
    const tip = advanceOrigin(bare);
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-00000002", prompt: "no pull" });
    expect(wt.fetched).toBeUndefined();
    expect(sh(wt.path, "rev-parse", "HEAD")).not.toBe(tip);
  });
  test("a failing fetch is not fatal: the local base is used", async () => {
    const repo = makeGitRepo(); // no origin at all
    const logs: string[] = [];
    const m = new WorktreeManager({ root: tmp("root"), log: (x) => logs.push(x) });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-00000003", prompt: "offline", pullFromOrigin: true });
    expect(wt.fetched).toBe(false);
    expect(wt.baseRef).toBe("main");
    expect(logs.join("\n")).toContain("fetch from origin failed");
  });
  test("existing mode fetches the branch from origin", async () => {
    const { repo, bare } = repoWithOrigin();
    const other = tmp("clone");
    sh(other, "clone", "-q", bare, ".");
    sh(other, "checkout", "-q", "-b", "feature/x");
    writeFileSync(join(other, "f.txt"), "f\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "feature");
    sh(other, "push", "-q", "origin", "feature/x");
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-00000004", branchMode: "existing", branch: "feature/x", pullFromOrigin: true });
    expect(wt.fetched).toBe(true);
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
  });
});

describe("rename after title", () => {
  test("a generated branch follows the title", async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-10000001", prompt: "hello there friend" });
    expect(wt.branch).toBe("rigwell/hello-there-friend");
    const next = await m.renameGeneratedBranch(wt.path, "Fix the flaky login test");
    expect(next).toBe("rigwell/fix-the-flaky-login-test");
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(next!);
    expect((await m.get(wt.path))?.branch).toBe(next!);
    expect(sh(repo, "branch", "--list", "rigwell/hello-there-friend")).toBe("");
    // renamed once only
    expect(await m.renameGeneratedBranch(wt.path, "Another title entirely")).toBeNull();
  });
  test("not renamed: user-picked name, own commits, upstream", async () => {
    const { repo } = repoWithOrigin();
    const m = new WorktreeManager({ root: tmp("root") });
    const picked = await m.create({ repoRoot: repo, sessionId: "s-10000002", branch: "my-branch" });
    expect(await m.renameGeneratedBranch(picked.path, "Some title here")).toBeNull();

    const committed = await m.create({ repoRoot: repo, sessionId: "s-10000003", prompt: "first words here" });
    writeFileSync(join(committed.path, "c.txt"), "c\n");
    sh(committed.path, "add", ".");
    sh(committed.path, "commit", "-qm", "own work");
    expect(await m.renameGeneratedBranch(committed.path, "Some title here")).toBeNull();

    const pushed = await m.create({ repoRoot: repo, sessionId: "s-10000004", prompt: "third set words" });
    sh(pushed.path, "push", "-q", "-u", "origin", pushed.branch);
    expect(await m.renameGeneratedBranch(pushed.path, "Some title here")).toBeNull();
  });
  test("a branch the user switched away from is left alone", async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-10000005", prompt: "switch away now" });
    sh(wt.path, "checkout", "-q", "-b", "elsewhere");
    expect(await m.renameGeneratedBranch(wt.path, "New title words")).toBeNull();
  });
});

describe("HEAD watching", () => {
  test("a checkout is reported once after the debounce", async () => {
    const repo = makeGitRepo();
    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-20000001", prompt: "watch head now" });
    const seen: unknown[] = [];
    const w = new HeadWatcher({ debounceMs: 50, onChange: (c) => seen.push(c) });
    await w.add(wt.path);
    sh(wt.path, "checkout", "-q", "-b", "other-branch");
    for (let i = 0; i < 60 && !seen.length; i++) await Bun.sleep(25);
    await Bun.sleep(150);
    expect(seen).toEqual([{ worktreePath: wt.path, branch: "other-branch", previousBranch: wt.branch }]);
    expect(await w.check(wt.path)).toBe(false); // nothing new
    w.close();
  });
});

describe("removal broadcast, trust, archive", () => {
  const settingsFor = (root: string) => ({ worktreeDirectory: root }) as any;

  test("cleanup broadcasts worktree.removed and forgets trust; creation marked it", async () => {
    const repo = makeGitRepo();
    const root = tmp("root");
    const m = managerFor(settingsFor(root));
    const events: [string, any][] = [];
    const off = onWorktreeNotification((method, p) => events.push([method, p]));
    const wt = await m.create({ repoRoot: repo, sessionId: "s-30000001", prompt: "remove me soon" });
    const trusted = () => JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders ?? {};
    expect(trusted()[wt.path]).toBeTruthy();
    await m.remove(wt.path);
    expect(events).toEqual([["worktree.removed", { worktreePath: wt.path, sessionId: "s-30000001", repoRoot: repo, branch: wt.branch }]]);
    expect(trusted()[wt.path]).toBeUndefined();
    off();
  });

  test("markTrusted keeps other settings keys", () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ keep: 1 }));
    markTrusted("/some/folder");
    forgetTrusted("/other");
    const j = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(j.keep).toBe(1);
    expect(Object.keys(j.trustedFolders)).toEqual([resolve("/some/folder")]); // stored as an absolute path (Windows adds the drive)
  });

  test("onSessionArchived removes a safe ephemeral worktree, keeps dirty, persistent and pinned ones", async () => {
    const repo = makeGitRepo();
    const root = tmp("root");
    const s = settingsFor(root);
    const m = managerFor(s);
    const events: string[] = [];
    const off = onWorktreeNotification((method, p) => events.push(`${method}:${p.sessionId}`));
    const safe = await m.create({ repoRoot: repo, sessionId: "s-40000001", prompt: "safe one here" });
    const dirty = await m.create({ repoRoot: repo, sessionId: "s-40000002", prompt: "dirty one here" });
    writeFileSync(join(dirty.path, "mine.txt"), "work\n");
    const persistent = await m.create({ repoRoot: repo, sessionId: "s-40000003", prompt: "kept one here", lifecycle: "persistent" });
    const pinned = await m.create({ repoRoot: repo, sessionId: "s-40000004", prompt: "pinned one here" });
    await m.updateMeta(pinned.path, { pinned: true });

    expect(await onSessionArchived("s-40000001", s)).toBe(safe.path);
    expect(existsSync(safe.path)).toBe(false);
    expect(await onSessionArchived("s-40000002", s)).toBeNull();
    expect(await onSessionArchived("s-40000003", s)).toBeNull();
    expect(await onSessionArchived("s-40000004", s)).toBeNull();
    expect(await onSessionArchived("no-such-session", s)).toBeNull();
    expect(existsSync(dirty.path) && existsSync(persistent.path) && existsSync(pinned.path)).toBe(true);
    expect(events).toEqual(["worktree.removed:s-40000001"]);
    off();
    closeHeadWatchers();
  });
});

describe("housekeeping", () => {
  class Host implements HousekeepingHost {
    archived: string[] = [];
    constructor(public recs: SessionRecord[]) {}
    sessions() { return this.recs; }
    archive(id: string) { this.archived.push(id); const r = this.recs.find((x) => x.sessionId === id); if (r) r.archived = true; }
  }

  test("archives sessions whose folder is gone, removes old orphans, prunes", async () => {
    const repo = makeGitRepo();
    let now = Date.parse("2026-03-01T00:00:00Z");
    const m = new WorktreeManager({ root: tmp("root"), now: () => now });
    const gone = await m.create({ repoRoot: repo, sessionId: "s-50000001", prompt: "gone folder here" });
    const orphan = await m.create({ repoRoot: repo, sessionId: "s-50000002", prompt: "orphan tree here" });
    const orphanDirty = await m.create({ repoRoot: repo, sessionId: "s-50000003", prompt: "orphan dirty here" });
    const active = await m.create({ repoRoot: repo, sessionId: "s-50000004", prompt: "active tree here" });
    for (const w of [orphan, orphanDirty, active]) await m.runSetup(w, undefined); // writes receipts at `now`
    writeFileSync(join(orphanDirty.path, "mine.txt"), "x\n");
    rmSync(gone.path, { recursive: true, force: true }); // the user deleted the folder

    const host = new Host([
      { sessionId: "s-50000001", worktreePath: gone.path, repoRoot: repo, archived: false },
      { sessionId: "s-50000002", worktreePath: orphan.path, repoRoot: repo, archived: true },
      { sessionId: "s-50000003", worktreePath: orphanDirty.path, repoRoot: repo, archived: true },
      { sessionId: "s-50000004", worktreePath: active.path, repoRoot: repo, archived: false },
    ]);
    const hk = new Housekeeper({ manager: () => m, host, now: () => now });

    // Receipts are fresh: nothing is removed yet; the vanished folder is archived and pruned.
    let r = await hk.tick();
    expect(r.archived).toEqual(["s-50000001"]);
    expect(r.removed).toEqual([]);
    expect(r.pruned).toEqual([repo]);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(gone.path);

    now += 25 * 3600_000;
    host.archived = [];
    r = await hk.tick();
    expect(r.removed).toEqual([orphan.path]); // dirty one and the active session's one stay
    expect(existsSync(orphanDirty.path) && existsSync(active.path)).toBe(true);
    expect(host.archived).toEqual([]); // already archived sessions are not archived again
  });

  test("the timer is injectable and runs ticks", async () => {
    let fn: (() => void) | undefined;
    let ms = 0;
    let cleared = false;
    let ticks = 0;
    const hk = new Housekeeper({
      manager: () => { ticks++; return new WorktreeManager({ root: tmp("root") }); },
      host: new Host([]),
      setTimer: (f, n) => { fn = f; ms = n; return 1; },
      clearTimer: () => { cleared = true; },
    });
    hk.start();
    expect(ms).toBe(5 * 60_000);
    fn!();
    await Bun.sleep(50);
    expect(ticks).toBe(1);
    hk.stop();
    expect(cleared).toBe(true);
  });
});

describe("profile index", () => {
  test("lastUsedProfileId and deleted profiles keep name and cleanup script", async () => {
    const repo = makeGitRepo();
    saveLocalProfile(repo, { id: "node", name: "Node setup", script: "echo up", cleanupScript: process.platform === "win32" ? "Set-Content -Path \"$env:REPO_ROOT_PATH\\cleaned.txt\" -Value cleaned" : "echo cleaned > \"$REPO_ROOT_PATH/cleaned.txt\"" });
    setLastUsedProfile(repo, "node");
    expect(readProfileIndex(repo).lastUsedProfileId).toBe("node");
    expect(findProfile(repo, "node")?.script).toBe("echo up");

    const m = new WorktreeManager({ root: tmp("root") });
    const wt = await m.create({ repoRoot: repo, sessionId: "s-60000001", prompt: "profile tree here", setupProfileId: "node" });
    expect(deleteLocalProfile(repo, "node")).toBe(true);
    expect(deleteLocalProfile(repo, "node")).toBe(false);

    const idx = readProfileIndex(repo);
    expect(idx.lastUsedProfileId).toBeUndefined();
    expect(idx.deleted.node?.name).toBe("Node setup");
    const gone = findProfile(repo, "node");
    expect(gone).toMatchObject({ id: "node", name: "Node setup", source: "local" });
    expect(gone?.script).toBeUndefined();

    // The old worktree can still be cleaned up with the kept script.
    const res = await m.remove(wt.path);
    expect(res.cleanup?.ok).toBe(true);
    expect(readFileSync(join(repo, "cleaned.txt"), "utf8").trim()).toBe("cleaned");
  });
});

describe("live-session key (Windows simulation)", () => {
  test("Windows keys ignore case and separators; POSIX keys are the path as given", async () => {
    const { activeKey } = await import("../../src/worktree/connect.ts");
    expect(activeKey("C:\\Users\\Runner\\wt\\a\\b", "win32")).toBe(activeKey("c:/users/runner/WT/a/b", "win32"));
    expect(activeKey("/tmp/Wt/a", "linux")).toBe("/tmp/Wt/a");
    expect(activeKey("/tmp/Wt/a", "linux")).not.toBe(activeKey("/tmp/wt/a", "linux"));
  });
});

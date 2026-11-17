import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path, { basename, join } from "node:path";
import { WorktreeError, WorktreeManager, branchSlug, resolveRoot, worktreePathFor } from "../../src/worktree/manager.ts";
import { parseWorktreeInclude, copyWorktreeIncludes } from "../../src/worktree/include.ts";
import { checkoutBranch, commit, listBranches } from "../../src/worktree/actions.ts";
import { isSecretName, stripSecrets } from "../../src/worktree/env.ts";
import { runScript } from "../../src/worktree/scripts.ts";
import { makeGitRepo, sh, tmp } from "./util.ts";

const mk = (extra: Record<string, unknown> = {}) => new WorktreeManager({ root: tmp("root"), ...extra });

describe("names and paths", () => {
  test("branch slug: up to 5 words, padded to 3, 32 chars", () => {
    expect(branchSlug("Fix the login bug please now and later")).toBe("rigwell/fix-the-login-bug-please");
    expect(branchSlug("hi")).toBe("rigwell/hi-work-task");
    expect(branchSlug("a very long prompt about refactoring everything")!.length).toBeLessThanOrEqual(32);
  });
  test("worktree path uses last 8 chars of the session id and sanitises", () => {
    expect(worktreePathFor("/r", "0123456789abcdef", "/x/my repo")).toBe(path.join("/r", "89abcdef", "my-repo"));
  });
  test("a relative worktreeDirectory is ignored with a warning", () => {
    const warns: string[] = [];
    expect(resolveRoot("rel/dir", (m) => warns.push(m))).not.toBe("rel/dir");
    expect(warns.length).toBe(1);
    expect(resolveRoot("/abs/dir")).toBe(path.resolve("/abs/dir")); // Windows adds the drive
  });
});

describe("secret stripping", () => {
  test("rule", () => {
    for (const n of ["FAKE_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "MY_SECRET", "AWS_ACCESS_KEY_ID", "DATABASE_URL", "REDIS_URL", "RIGWELL_HOME", "SSH_AUTH_SOCK", "OPENAI_BASE", "GOOGLE_APPLICATION_CREDENTIALS", "SIGNING_PRIVATE_KEY"]) {
      expect(isSecretName(n)).toBe(true);
    }
    for (const n of ["PATH", "HOME", "NORMAL_VAR", "LANG", "NODE_ENV", "PUBLIC_URL"]) expect(isSecretName(n)).toBe(false);
    expect(stripSecrets({ A_TOKEN: "x", B: "y" })).toEqual({ B: "y" });
  });
  test("script env: secrets absent, normal vars and REPO_ROOT_PATH present", async () => {
    process.env.FAKE_API_KEY = "sk-nope";
    process.env.NORMAL_VAR = "visible";
    const dir = tmp("s");
    // Windows runs setup scripts with PowerShell (spec 18.3); POSIX hosts use bash.
    const script = process.platform === "win32"
      ? 'Write-Output "key=[$(if ($env:FAKE_API_KEY) { $env:FAKE_API_KEY } else { \'unset\' })] normal=[$env:NORMAL_VAR] repo=[$env:REPO_ROOT_PATH]"'
      : 'echo "key=[${FAKE_API_KEY-unset}] normal=[$NORMAL_VAR] repo=[$REPO_ROOT_PATH]"';
    const r = await runScript({ script, cwd: dir, repoRoot: "/the/repo", timeoutMs: 10000 });
    expect(r.output).toContain("key=[unset] normal=[visible] repo=[/the/repo]");
  });
  test("output is capped at 4 KB and control chars removed", async () => {
    const script = process.platform === "win32"
      ? '[Console]::Write(([char]27).ToString() + "[31m" + ("a" * 9000))'
      : 'printf "\\033[31m"; head -c 9000 /dev/zero | tr "\\0" "a"';
    const r = await runScript({ script, cwd: tmp("s"), repoRoot: "/r", timeoutMs: 10000 });
    expect(r.output.length).toBe(4096);
    expect(r.output).not.toContain("\u001b");
  });
  test("a script is killed at its timeout", async () => {
    const r = await runScript({ script: "sleep 30", cwd: tmp("s"), repoRoot: "/r", timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe(".worktreeinclude", () => {
  test("parse: comments, blanks, escaping paths dropped", () => {
    expect(parseWorktreeInclude("# c\n\n.env\n../evil\n/abs\nsecrets/\n")).toEqual([".env", "secrets"]);
    expect(() => parseWorktreeInclude("x\n".repeat(501))).toThrow();
    expect(() => parseWorktreeInclude("a".repeat(70_000))).toThrow();
  });
  test("copies ignored files only, skips symlinks and tracked files, never overwrites", async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, ".env"), "K=1\n");
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "k.txt"), "k\n");
    const outside = tmp("include-outside");
    writeFileSync(join(outside, "secret.txt"), "must not copy");
    symlinkSync(outside, join(repo, "link.env"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\nsecrets\na.txt\nlink.env\nmissing\n");
    const dest = tmp("dest");
    writeFileSync(join(dest, "preexisting"), "x");
    const res = await copyWorktreeIncludes(repo, dest);
    expect(res.copied.sort()).toEqual([".env", "secrets/k.txt"]);
    expect(res.skipped.map((s) => s.path).sort()).toEqual(["a.txt", "link.env", "missing"]);
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("K=1\n");
    writeFileSync(join(dest, ".env"), "changed");
    await copyWorktreeIncludes(repo, dest);
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("changed");
  });
});

describe("create, status, remove", () => {
  test("creates a worktree and branch, copies includes, main checkout untouched", async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, ".env"), "K=1\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
    sh(repo, "add", ".worktreeinclude");
    sh(repo, "commit", "-qm", "inc");
    const m = mk();
    const wt = await m.create({ repoRoot: repo, sessionId: "sess-12345678", prompt: "Fix the parser bug" });
    expect(wt.path).toBe(join(m.root, "12345678", basename(repo)));
    expect(wt.branch).toBe("rigwell/fix-the-parser-bug");
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("K=1\n");
    expect(sh(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // branch name clash gets -2
    const wt2 = await m.create({ repoRoot: repo, sessionId: "other-87654321", prompt: "Fix the parser bug" });
    expect(wt2.branch).toBe("rigwell/fix-the-parser-bug-2");
    // no prompt: <current>-wt
    const wt3 = await m.create({ repoRoot: repo, sessionId: "third-00000003" });
    expect(wt3.branch).toBe("main-wt");
    expect((await m.list()).length).toBe(3);
    expect((await m.get(wt.path))?.sessionId).toBe("sess-12345678");
  });

  test("not a repo is refused", async () => {
    await expect(mk().create({ repoRoot: tmp("plain"), sessionId: "abcdefgh" })).rejects.toThrow(WorktreeError);
  });

  test("existing mode: refuses the root branch and occupied branches", async () => {
    const repo = makeGitRepo();
    sh(repo, "branch", "feature");
    const m = mk();
    await expect(m.create({ repoRoot: repo, sessionId: "aaaaaaaa", branchMode: "existing", branch: "main" })).rejects.toMatchObject({ code: "root_branch" });
    const a = await m.create({ repoRoot: repo, sessionId: "bbbbbbbb", branchMode: "existing", branch: "feature" });
    expect(sh(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    await expect(m.create({ repoRoot: repo, sessionId: "cccccccc", branchMode: "existing", branch: "feature" })).rejects.toMatchObject({ code: "branch_occupied" });
    await expect(m.create({ repoRoot: repo, sessionId: "dddddddd", branchMode: "existing", branch: "nope" })).rejects.toMatchObject({ code: "branch_missing" });
  });

  test("status: dirty, ahead; setup output is not user work", async () => {
    const repo = makeGitRepo();
    const m = mk();
    const wt = await m.create({ repoRoot: repo, sessionId: "statuss1" });
    expect((await m.status(wt.path)).dirty).toBe(false);
    // setup creates an untracked file; the receipt marks it as setup output
    writeFileSync(join(wt.path, "setup-out.txt"), "generated\n");
    await m.runSetup(wt, { id: "p", source: "local", name: "p" });
    let st = await m.status(wt.path);
    expect(st.changedFiles).toEqual(["setup-out.txt"]);
    expect(st.dirty).toBe(false);
    // edited setup output counts as user work
    writeFileSync(join(wt.path, "setup-out.txt"), "edited\n");
    expect((await m.status(wt.path)).dirty).toBe(true);
    writeFileSync(join(wt.path, "setup-out.txt"), "generated\n");
    writeFileSync(join(wt.path, "a.txt"), "two\n");
    st = await m.status(wt.path);
    expect(st.userChangedFiles).toEqual(["a.txt"]);
    await commit(wt.path, "change a");
    st = await m.status(wt.path);
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(0);
    expect(st.dirty).toBe(false);
  });

  test("remove refuses uncommitted work, force removes; branch kept unless asked", async () => {
    const repo = makeGitRepo();
    const m = mk();
    const wt = await m.create({ repoRoot: repo, sessionId: "removee1" });
    writeFileSync(join(wt.path, "new.txt"), "work\n");
    await expect(m.remove(wt.path)).rejects.toMatchObject({ code: "dirty" });
    const r = await m.remove(wt.path, { force: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(join(m.root, "removee1"))).toBe(false);
    expect(r.branchDeleted).toBe(false);
    expect(sh(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
    const wt2 = await m.create({ repoRoot: repo, sessionId: "removee2" });
    const r2 = await m.remove(wt2.path, { deleteLocalBranch: true });
    expect(r2.branchDeleted).toBe(true);
    expect(sh(repo, "branch", "--list", wt2.branch)).toBe("");
  });

  test("remove refuses an in-use worktree and a non-managed path", async () => {
    const repo = makeGitRepo();
    const used = new Set<string>();
    const m = mk({ inUse: (p: string) => used.has(p) });
    const wt = await m.create({ repoRoot: repo, sessionId: "inuse001" });
    used.add(wt.path);
    await expect(m.remove(wt.path)).rejects.toMatchObject({ code: "in_use" });
    await expect(m.remove(repo)).rejects.toMatchObject({ code: "not_managed" });
  });
});

describe("auto-delete", () => {
  test("removes LRU ephemeral worktrees over the limit, skipping dirty, pinned, persistent, local-only commits, recent", async () => {
    const repo = makeGitRepo();
    let t = 1_000_000;
    const m = mk({ autoDeleteLimit: 2, recentMs: 60_000, now: () => t });
    const ids = ["old00001", "old00002", "old00003", "old00004", "old00005", "old00006"];
    const wts = [];
    // This exercises cleanup blockers, so avoid repeated generated-name collision probes in fixture setup.
    for (const id of ids) { wts.push(await m.create({ repoRoot: repo, sessionId: id, branch: `cleanup-${id}`, lifecycle: id === "old00006" ? "persistent" : "ephemeral" })); t += 1000; }
    const [w1, w2, w3, w4, w5] = wts;
    writeFileSync(join(w1!.path, "dirty.txt"), "wip\n");           // uncommitted work: skipped
    writeFileSync(join(w2!.path, "a.txt"), "ahead\n");              // local-only commit: skipped
    await commit(w2!.path, "local only");
    await m.updateMeta(w3!.path, { pinned: true });                 // pinned: skipped
    t += 10 * 60_000;
    await m.touch(w5!.path);                                        // recently used: skipped
    const removed = await m.autoDelete();
    expect(removed).toEqual([w4!.path]);
    for (const w of [w1!, w2!, w3!, w5!, wts[5]!]) expect(existsSync(w.path)).toBe(true);
    expect(existsSync(w4!.path)).toBe(false);
  });

  test("a new creation triggers the pass and reports what it removed", async () => {
    const repo = makeGitRepo();
    let t = 0;
    const m = mk({ autoDeleteLimit: 1, recentMs: 0, now: () => (t += 1000) });
    const a = await m.create({ repoRoot: repo, sessionId: "first001" });
    const b = await m.create({ repoRoot: repo, sessionId: "second02" });
    expect(b.autoDeleted).toEqual([]);          // 1 existing, limit 1: not over
    const c = await m.create({ repoRoot: repo, sessionId: "third003" });
    expect(c.autoDeleted).toEqual([a.path]);    // 2 existing > 1: oldest goes
    expect(existsSync(b.path)).toBe(true);
  });
});

describe("git actions", () => {
  test("branches, checkout needs resolution when dirty, stash resolves", async () => {
    const repo = makeGitRepo();
    sh(repo, "branch", "other");
    const m = mk();
    const wt = await m.create({ repoRoot: repo, sessionId: "actions1" });
    expect((await listBranches(wt.path)).local).toContain("other");
    writeFileSync(join(wt.path, "w.txt"), "wip\n");
    const r = await checkoutBranch(wt.path, "other");
    expect(r).toMatchObject({ ok: false, needsResolution: true, changedFiles: ["w.txt"] });
    const r2 = await checkoutBranch(wt.path, "other", { mode: "stash" });
    expect(r2.ok).toBe(true);
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
    expect(existsSync(join(wt.path, "w.txt"))).toBe(false);
  });
});

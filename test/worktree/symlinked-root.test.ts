// A repo reached through a symlinked folder (macOS: /var and /tmp point into /private) behaves like the real path.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitRepo, tmp } from "./util.ts";
import { canonicalPath } from "../../src/worktree/git.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import { localProfilesDir, saveLocalProfile, findProfile } from "../../src/worktree/profiles.ts";
import { isFolderTrusted } from "../../src/storage/settings.ts";
import { startSessionWorktree } from "../../src/worktree/connect.ts";

function linkTo(real: string): string {
  const holder = mkdtempSync(join(realpathSync.native(tmpdir()), "rigwell-link-"));
  const link = join(holder, "via-link");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

describe("symlinked folders", () => {
  test("canonicalPath resolves links and keeps missing paths", () => {
    const repo = makeGitRepo();
    const link = linkTo(repo);
    expect(canonicalPath(link)).toBe(repo);
    expect(canonicalPath(join(repo, "nope"))).toBe(join(repo, "nope"));
  });

  test("setup profiles are shared between the link and the real path", () => {
    process.env.RIGWELL_HOME = tmp("home");
    const repo = makeGitRepo();
    const link = linkTo(repo);
    expect(localProfilesDir(link)).toBe(localProfilesDir(repo));
    saveLocalProfile(link, { id: "p", name: "P", script: "echo hi" });
    expect(findProfile(repo, "p")?.script).toBe("echo hi");
  });

  test("a trusted folder given as a link trusts the real path and the reverse", () => {
    // Folder trust resolves paths; it does not inspect git history.
    const repo = tmp("trust-root");
    const link = linkTo(repo);
    expect(isFolderTrusted(repo, { [link]: {} }, {})).toBe(true);
    expect(isFolderTrusted(link, { [repo]: {} }, {})).toBe(true);
    expect(isFolderTrusted(tmp("other"), { [link]: {} }, {})).toBe(false);
  });

  test("a session started in a subfolder reached through a link lands in the matching worktree subfolder", async () => {
    process.env.RIGWELL_HOME = tmp("home");
    const repo = makeGitRepo();
    const link = linkTo(repo);
    const w = await startSessionWorktree({ enabled: true, prompt: "link run" }, join(link, "src"), "s-70000001", { worktreeDirectory: tmp("root") } as any);
    expect(w?.cwd).toBe(join(w!.info.path, "src"));
    await w!.manager.remove(w!.info.path, { force: true });
  });

  test("the manager lists worktrees for a repo given through a link", async () => {
    process.env.RIGWELL_HOME = tmp("home");
    const repo = makeGitRepo();
    const link = linkTo(repo);
    const m = new WorktreeManager({ root: tmp("root") });
    await m.create({ repoRoot: repo, sessionId: "s-70000002", prompt: "listed" });
    expect((await m.list({ repoRoot: link })).length).toBe(1);
  });
});

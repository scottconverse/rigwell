// Helpers for worktree tests: temp git repos with a commit identity set through the environment.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
});

export const tmp = (prefix: string) => mkdtempSync(join(realpathSync.native(tmpdir()), `rigwell-wt-${prefix}-`));

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();
}

/** A repo on branch `main` with one commit (a.txt) and a .gitignore for .env. */
export function makeGitRepo(): string {
  const dir = tmp("repo");
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), ".env\nsecrets/\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "x.js"), "export const x = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

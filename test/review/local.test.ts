import { expect, test } from "bun:test";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addressReview, diffLines, localReview, reviewComments } from "../../src/review/local.ts";
import { makeGitRepo, sh } from "../worktree/util.ts";

test("branch review includes committed, staged, unstaged, renamed, removed and untracked files with real line positions", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "code.ts"), "export function oldName() { return 1; }\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "base");
  sh(repo, "checkout", "-qb", "feature/review");
  renameSync(join(repo, "code.ts"), join(repo, "renamed.ts")); sh(repo, "add", "."); sh(repo, "commit", "-qm", "move code");
  writeFileSync(join(repo, "a.txt"), "staged\n"); sh(repo, "add", "a.txt");
  writeFileSync(join(repo, "renamed.ts"), "export function renamed() { return 1; }\n");
  unlinkSync(join(repo, "src/x.js"));
  writeFileSync(join(repo, "new.ts"), "function added() { return 2; }\n");
  writeFileSync(join(repo, " spaced.ts"), "function spaced() {}\n");
  const review = await localReview(repo);
  expect(review.files.map((f) => f.path).sort()).toEqual([" spaced.ts", "a.txt", "code.ts", "new.ts", "renamed.ts", "src/x.js"].sort());
  expect(review.files.find((f) => f.path === "a.txt")?.lines).toMatchObject([{ kind: "hunk" }, { kind: "removed", oldLine: 1 }, { kind: "added", newLine: 1 }]);
  expect(review.semantic.changes.find((c) => c.name === "renamed")).toMatchObject({ kind: "moved", renamed: true, from: { path: "code.ts" }, to: { path: "renamed.ts" } });
  expect(sh(repo, "status", "--porcelain")).toContain("renamed.ts");
  const comments = reviewComments(review, [{ path: "renamed.ts", side: "new", line: 1, body: "Please add coverage." }]);
  expect(addressReview(review, comments)).toContain('"renamed.ts":1 (after)\nPlease add coverage.');
  expect(() => reviewComments(review, [{ path: "outside.ts", side: "new", line: 1, body: "bad" }])).toThrow("outside");
  expect(() => reviewComments(review, [{ path: "renamed.ts", side: "new", line: 99, body: "bad" }])).toThrow("outside");
});

test("unified hunk parsing retains before/after line numbers across separate hunks", () => {
  expect(diffLines("--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +3,2 @@\n-removed\n+added\n context\n@@ -10 +11 @@\n-last\n+next\n")).toEqual([
    { kind: "hunk", text: "@@ -2,2 +3,2 @@" }, { kind: "removed", text: "removed", oldLine: 2 }, { kind: "added", text: "added", newLine: 3 }, { kind: "context", text: "context", oldLine: 3, newLine: 4 },
    { kind: "hunk", text: "@@ -10 +11 @@" }, { kind: "removed", text: "last", oldLine: 10 }, { kind: "added", text: "next", newLine: 11 },
  ]);
});

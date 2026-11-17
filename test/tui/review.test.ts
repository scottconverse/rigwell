import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildView } from "../../src/tui/views.ts";
import { ReviewService } from "../../src/review/service.ts";
import { makeGitRepo, sh } from "../worktree/util.ts";
import { driver, ev, key, type } from "./helpers.ts";

test("/review opens a real branch summary and tree-sitter semantic text without changing the checkout", async () => {
  const repo = makeGitRepo(); writeFileSync(join(repo, "code.ts"), "function before() { return 1; }"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "baseline");
  writeFileSync(join(repo, "code.ts"), "function after() { return 1; }");
  expect(key(type(driver(), "/review"), "enter").effects).toEqual([{ type: "view", name: "review", args: "" }]);
  const service = new ReviewService({ cwd: () => repo });
  const result = await buildView("review", "main", { state: { ...driver().s, cwd: repo }, connection: "local", request: (method, params) => service.handle(method, params) });
  expect(result.title).toBe("Review"); expect(result.lines.join("\n")).toContain("moved/renamed function after: code.ts:1 to code.ts:1");
  expect(sh(repo, "status", "--porcelain")).toContain("code.ts");
});

test("/review pr passes a PR number and review confirmations show every line comment", async () => {
  const calls: any[] = [];
  const result = await buildView("review", "pr 7", { state: driver().s, connection: "local", request: async (method, params) => { calls.push({ method, params }); return { files: [], base: "a", head: "b", semantic: { changes: [], warnings: [] }, comments: [], checks: [{ name: "test", state: "success" }], pr: { number: 7, title: "Fixture", state: "open" } }; } });
  expect(calls[0]).toMatchObject({ method: "review_snapshot", params: { pr: 7 } }); expect(result.lines).toContain("test: success");
  const prompt = ev(driver(), { type: "request", id: "review", method: "request_permission", params: { toolUses: [{ confirmationType: "code_review", details: { repository: "owner/repo", number: 7, head: "abc", event: "REQUEST_CHANGES", body: "Summary", comments: [{ path: "code.ts", side: "new", line: 2, body: "Please fix" }] } }], options: [{ label: "Post", value: "proceed_once" }, { label: "Cancel", value: "cancel" }] } });
  expect(prompt.s.panels[0].title).toBe("Post review to the PR?"); expect(prompt.s.panels[0].body.join("\n")).toContain("code.ts:2 (new)\nPlease fix");
});

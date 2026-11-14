import { expect, test } from "bun:test";
import { buildView } from "../../src/tui/views.ts";
import { initialState, permissionPanel } from "../../src/tui/reducer.ts";
import { driver, key, type } from "./helpers.ts";

test("/pr dispatches its view, displays state and checks, and creates with quoted multiline body", async () => {
  expect(key(type(driver(), "/pr"), "enter").effects).toEqual([{ type: "view", name: "pr", args: "" }]);
  const calls: any[] = [];
  const c = { state: initialState({ cwd: "fixture", rows: 24, cols: 80 } as any), connection: "test", request: async (m: string, p: any) => {
    calls.push({ m, p });
    return m === "create_pr" ? { number: 7, url: "https://github.com/owner/repo/pull/7" } : { number: 7, state: "open", checks: [{ name: "test", state: "pending" }] };
  } };
  expect((await buildView("pr", "", c)).lines.join("\n")).toContain("test: pending");
  expect((await buildView("pr", 'create "A title" "line one\nline two" main --draft', c)).lines).toContain("Created #7");
  expect(calls[1]).toEqual({ m: "create_pr", p: { worktreePath: "fixture", title: "A title", body: "line one\nline two", base: "main", draft: true } });
});

test("PR permission shows the exact proposed branch, base, title and body", () => {
  const p = permissionPanel("request", { toolUses: [{ confirmationType: "create_pr", details: { repository: "github.com/owner/repo", branch: "feature", base: "main", title: "Title", body: "Body line", draft: true } }], options: [{ label: "Cancel", value: "cancel" }] });
  expect(p.title).toBe("Push branch and create PR?");
  expect(p.body).toEqual(["Repository: github.com/owner/repo", "Branch: feature", "Base: main", "Title: Title", "Draft: yes", "", "Body line"]);
});

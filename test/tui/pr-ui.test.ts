// The create_pr UI pieces: the TUI /pr command, its permission panel and result text, and the desktop chip and
// request handler. Pure functions only; the protocol path is in test/e2e/create-pr.test.ts.
import { describe, expect, test } from "bun:test";
import { permissionPanel } from "../../src/tui/reducer.ts";
import { prText } from "../../src/tui/app.ts";
import { prChip, prRequestHandler } from "../../desktop/renderer/lib/pr.ts";
import { driver, key, type } from "./helpers.ts";

const details = { branch: "rigwell/fix", base: "main", remote: "origin", title: "Fix it", body: "Line one\nLine two", draft: true };
const permission = (confirmationType: string) => ({
  requestId: "r1",
  toolUses: [{ toolUse: { type: "tool_use", id: "u1", name: "CreatePullRequest", input: {} }, confirmationType, details }],
  options: [{ label: "Push and create the pull request", value: "proceed_once" }, { label: "Cancel", value: "cancel" }],
});

describe("TUI /pr", () => {
  test("/pr with a title sends create_pr; /pr status sends get_pr_status; both show the result", () => {
    const made = key(type(driver(), "/pr Fix the greeting"), "enter");
    expect(made.effects).toContainEqual({ type: "rpc", method: "create_pr", params: { title: "Fix the greeting" }, label: "pr", after: "show_pr" });
    const st = key(type(driver(), "/pr status"), "enter");
    expect(st.effects).toContainEqual({ type: "rpc", method: "get_pr_status", params: {}, label: "pr status", after: "show_pr" });
    const bare = key(type(driver(), "/pr"), "enter");
    expect(bare.effects).toContainEqual({ type: "rpc", method: "create_pr", params: {}, label: "pr", after: "show_pr" });
  });

  test("the create_pr permission panel shows branch, base, title and every body line", () => {
    const p = permissionPanel("r1", permission("create_pr")) as any;
    expect(p.title).toBe("Push and create a pull request");
    expect(p.body).toEqual(["Branch: rigwell/fix into main on origin (draft)", "Title:  Fix it", "", "Line one", "Line two"]);
  });

  test("prText covers cancel, created, none and open with checks", () => {
    expect(prText({ created: false, cancelled: true })).toBe("pr: cancelled; nothing was pushed");
    expect(prText({ created: true, number: 7, url: "https://x/pull/7" })).toBe("pr: created #7 https://x/pull/7");
    expect(prText({ state: "none", branch: "b" })).toBe("pr: no pull request for b");
    expect(prText({ state: "open", number: 7, url: "u", checks: { state: "failing", passed: 1, failed: 2, pending: 0, total: 3 } }))
      .toBe("pr: #7 open, checks failing (1 passed, 2 failed, 0 running) u");
  });
});

describe("desktop PR helpers", () => {
  test("prChip: no chip without a PR; tone follows the checks", () => {
    expect(prChip(null)).toBeNull();
    expect(prChip({ state: "none" })).toBeNull();
    expect(prChip({ state: "merged", number: 3 })).toEqual({ text: "#3 merged", tone: "muted" });
    expect(prChip({ state: "open", number: 3, checks: { total: 2, passed: 2, failed: 0, pending: 0, state: "passing" } })).toEqual({ text: "#3 open · checks pass (2/2)", tone: "ok" });
    expect(prChip({ state: "open", number: 3, draft: true, checks: { total: 2, passed: 0, failed: 0, pending: 2, state: "pending" } })).toEqual({ text: "#3 draft · 2 running", tone: "warn" });
    expect(prChip({ state: "open", number: 3, checks: { total: 2, passed: 1, failed: 1, pending: 0, state: "failing" } })?.tone).toBe("bad");
  });

  test("prRequestHandler: create_pr asks the dialog; other permissions are a cancel; other requests get {}", async () => {
    const seen: any[] = [];
    let yes = true;
    const h = prRequestHandler(async (d) => { seen.push(d); return yes; });
    expect(await h("request_permission", permission("create_pr"))).toEqual({ selectedOption: "proceed_once" });
    yes = false;
    expect(await h("request_permission", permission("create_pr"))).toEqual({ selectedOption: "cancel" });
    expect(seen).toEqual([details, details]);
    expect(await h("request_permission", permission("exec"))).toEqual({ selectedOption: "cancel" });
    expect(await h("ask_user", {})).toEqual({});
    expect(seen).toHaveLength(2);
  });
});

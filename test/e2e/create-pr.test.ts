// create_pr and get_pr_status over the protocol (stream-jsonrpc exec): the client is asked first, a cancel pushes
// nothing, a yes pushes and opens the PR through a fake gh, and the worktree records it. Never real GitHub.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcChild, makeHome, makeRepo } from "./helpers.ts";
import { tmp } from "../worktree/util.ts";

const FAKE_GH = join(import.meta.dir, "../fakes/fake-gh.ts");
const MODEL = "custom:Fake-Anthropic-0";
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

describe("create_pr over the protocol", () => {
  test("asks first; cancel pushes nothing; yes pushes, opens the PR and records it; get_pr_status reads it", async () => {
    const repo = makeRepo();
    const bare = join(tmp("bare"), "acme", "widget.git");
    git(repo, "init", "-q", "--bare", bare);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "-u", "origin", "HEAD");
    const ghDir = tmp("gh");
    const home = makeHome([{ provider: "anthropic", url: "http://127.0.0.1:1", displayName: "Fake Anthropic" }]);
    const f = join(home, "settings.json");
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), worktreeDirectory: tmp("e2e-root") }));
    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], {
      cwd: repo, env: { RIGWELL_HOME: home, RIGWELL_TRUST_CWD: "1", RIGWELL_GH_CMD: JSON.stringify(["bun", FAKE_GH]), FAKE_GH_DIR: ghDir },
    });
    const asked: any[] = [];
    let answer = "cancel";
    c.onRequest = (m) => { asked.push(m); return m.method === "rigwell.request_permission" ? { selectedOption: answer } : {}; };
    try {
      const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL, worktree: { enabled: true, prompt: "fix greeting" } });
      const wt = init.worktree;
      const remoteHas = () => git(bare, "branch", "--list", wt.branch).includes(wt.branch);

      const cancelled = await c.call("create_pr", { title: "Fix the greeting", body: "Typo." });
      expect(cancelled).toEqual({ created: false, cancelled: true });
      expect(asked).toHaveLength(1);
      const tu = asked[0].params.toolUses[0];
      expect(asked[0].method).toBe("rigwell.request_permission");
      expect(tu.confirmationType).toBe("create_pr");
      expect(tu.details).toMatchObject({ branch: wt.branch, title: "Fix the greeting", body: "Typo." });
      expect(remoteHas()).toBe(false);
      expect(existsSync(join(ghDir, "calls.jsonl"))).toBe(false);

      answer = "proceed_once";
      const made = await c.call("create_pr", { title: "Fix the greeting", body: "Typo." });
      expect(made).toMatchObject({ created: true, url: "https://github.com/acme/widget/pull/7", number: 7, branch: wt.branch, via: "gh" });
      expect(remoteHas()).toBe(true);
      const listed = (await c.call("list_managed_worktrees", {})).worktrees;
      expect(listed.find((w: any) => w.path === wt.path)?.pr).toEqual({ number: 7, url: "https://github.com/acme/widget/pull/7" });

      writeFileSync(join(ghDir, "fake-gh.json"), JSON.stringify({ view: { number: 7, url: "https://github.com/acme/widget/pull/7", state: "OPEN", isDraft: false, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] } }));
      const st = await c.call("get_pr_status", { worktreePath: wt.path });
      expect(st).toMatchObject({ state: "open", number: 7, checks: { total: 1, passed: 1, state: "passing" } });
      await c.call("close_session", { reason: "other" });
    } finally {
      expect(await c.close()).toBe(0);
    }
  }, process.platform === "win32" ? 30_000 : 10_000);
});

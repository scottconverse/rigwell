// Phase 9 done-when: two sessions on one repo run in separate worktrees; a setup profile runs with
// secrets stripped; auto-delete skips a worktree with uncommitted work. (Against a local fake model.)
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { RpcChild, makeHome, makeRepo } from "./helpers.ts";
import { tmp } from "../worktree/util.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const MODEL = "custom:Fake-Anthropic-0";
const gitOut = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function patchSettings(home: string, extra: Record<string, unknown>) {
  const f = join(home, "settings.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...extra }, null, 2));
}

const editScript = (newText: string): FakeTurn[] => [
  { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] },
  { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: `"${newText}"` } }] },
  { text: "Edited greet.js." },
];
const idleScript = (): FakeTurn[] => [{ text: "Nothing to change." }];

/** Pins RIGWELL_TRUST_CWD=1 for the child so a repo with .rigwell/ never sends rigwell.request_trust (RpcChild does not answer it)
 *  whatever an earlier test file left in the shared bun process environment.
 *  Starts an exec session in a worktree, runs one prompt to completion, closes. */
async function runSession(repo: string, root: string, script: FakeTurn[], worktree: Record<string, unknown>, env: Record<string, string> = {}, extraSettings: Record<string, unknown> = {}) {
  const server = await startFakeAnthropic(script);
  servers.push(server);
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  patchSettings(home, { worktreeDirectory: root, ...extraSettings });
  const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", "low"], { cwd: repo, env: { RIGWELL_HOME: home, RIGWELL_TRUST_CWD: "1", ...env } });
  const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL, worktree: { enabled: true, ...worktree } });
  return { c, init, home, server };
}

async function finish(c: RpcChild, prompt = "change the greeting") {
  await c.call("add_user_message", { text: prompt });
  await c.turnCompleted();
  await c.call("close_session", { reason: "other" });
  expect(await c.close()).toBe(0);
}

describe("worktrees end to end", () => {
  test("two sessions on one repo run in separate worktrees; edits are isolated; main untouched", async () => {
    const repo = makeRepo();
    const root = tmp("e2e-root");
    const a = await runSession(repo, root, editScript("Hello, "), { prompt: "make greeting friendlier" });
    const b = await runSession(repo, root, editScript("Howdy, "), { prompt: "make greeting western" });
    const wa = a.init.worktree, wb = b.init.worktree;

    expect(wa.path).not.toBe(wb.path);
    expect(wa.branch).toBe("rigwell/make-greeting-friendlier");
    expect(wb.branch).toBe("rigwell/make-greeting-western");
    expect(wa.path.startsWith(root)).toBe(true);
    expect(wa.cwd).toBe(wa.path);
    expect(existsSync(join(wa.path, "greet.js")) && existsSync(join(wb.path, "greet.js"))).toBe(true);
    expect(wa.lifecycle).toBe("ephemeral");

    await Promise.all([finish(a.c), finish(b.c)]);

    expect(readFileSync(join(wa.path, "greet.js"), "utf8")).toContain('"Hello, "');
    expect(readFileSync(join(wb.path, "greet.js"), "utf8")).toContain('"Howdy, "');
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain('"Helo, "');
    expect(gitOut(repo, "status", "--porcelain")).toBe("");
    expect(gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD")).not.toMatch(/^rigwell\//);
    expect(gitOut(wa.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wa.branch);
    expect(gitOut(wb.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wb.branch);

    // The session record carries the worktree and its cwd is the worktree.
    const settingsFile = readdirSync(join(a.home, "sessions"), { recursive: true }).map(String).find((f) => f.endsWith(".settings.json"))!;
    const saved = JSON.parse(readFileSync(join(a.home, "sessions", settingsFile), "utf8"));
    expect(saved.worktree).toMatchObject({ path: wa.path, branch: wa.branch, lifecycle: "ephemeral" });
  });

  test("a setup profile runs with secrets stripped; REPO_ROOT_PATH set; protocol list/status/remove", async () => {
    const repo = makeRepo();
    const top = realpathSync.native(repo); // the same canonical path the profile folder hash is made from
    const root = tmp("e2e-root");
    const home = makeHome([{ provider: "anthropic", url: "http://127.0.0.1:1", displayName: "Fake Anthropic" }]);
    const dir = join(home, "worktree-setups", createHash("sha256").update(top).digest("hex"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dev.yaml"),
      process.platform === "win32"
        // Windows runs setup scripts with PowerShell (spec 18.3).
        ? 'name: Dev setup\nscript: |\n  Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" } | Set-Content setup-env.txt\n  Write-Output "normal=$env:NORMAL_VAR key=$(if ($env:FAKE_API_KEY) { $env:FAKE_API_KEY } else { \'unset\' }) tok=$(if ($env:MY_SERVICE_TOKEN) { $env:MY_SERVICE_TOKEN } else { \'unset\' }) repo=$env:REPO_ROOT_PATH"\ninitialPrompt: run the tests\n'
        : 'name: Dev setup\nscript: |\n  env > setup-env.txt\n  echo "normal=$NORMAL_VAR key=${FAKE_API_KEY-unset} tok=${MY_SERVICE_TOKEN-unset} repo=$REPO_ROOT_PATH"\ninitialPrompt: run the tests\n');
    patchSettings(home, { worktreeDirectory: root });
    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", "low"], {
      cwd: repo, env: { RIGWELL_HOME: home, FAKE_API_KEY: "sk-do-not-leak", MY_SERVICE_TOKEN: "tok-do-not-leak", NORMAL_VAR: "visible" },
    });
    const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL, worktree: { enabled: true, setupProfile: "dev" } });
    const setup = init.worktree.setup;
    expect(setup.ok).toBe(true);
    expect(setup.output).toContain(`normal=visible key=unset tok=unset repo=${top}`);
    expect(setup.initialPrompt).toBe("run the tests");
    const envDump = readFileSync(join(init.worktree.path, "setup-env.txt"), "utf8");
    expect(envDump).toContain("NORMAL_VAR=visible");
    expect(envDump).not.toContain("FAKE_API_KEY");
    expect(envDump).not.toContain("MY_SERVICE_TOKEN");
    expect(envDump).not.toContain("do-not-leak");
    expect(c.notifications().some((n) => n.type === "setup_step_progress" && n.text.includes("normal=visible"))).toBe(true);

    // setup output (setup-env.txt) does not make the worktree dirty
    const st = (await c.call("get_worktree_status", {})).status;
    expect(st.changedFiles).toEqual(["setup-env.txt"]);
    expect(st.dirty).toBe(false);
    const listed = (await c.call("list_managed_worktrees", {})).worktrees;
    expect(listed.map((w: any) => w.path)).toEqual([init.worktree.path]);

    // in use: cannot remove while the session is live; after close it can
    await expect(c.call("cleanup_worktree", { worktreePath: init.worktree.path })).rejects.toThrow(/live session/);
    await c.call("close_session", { reason: "other" });
    await c.close();
    const c2 = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], { cwd: repo, env: { RIGWELL_HOME: home } });
    const r = await c2.call("cleanup_worktree", { worktreePath: init.worktree.path });
    expect(r.removed).toBe(true);
    expect(r.branch).toBe(init.worktree.branch);
    expect(existsSync(init.worktree.path)).toBe(false);
    expect(gitOut(repo, "branch", "--list", init.worktree.branch)).toContain(init.worktree.branch); // branch kept
    await c2.close();
  }, process.platform === "win32" ? 30_000 : 5_000); // Windows: two cold bun starts plus PowerShell for the setup script on a slow runner

  test("a repository profile does not run in an untrusted folder", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".rigwell", "worktree-setups"), { recursive: true });
    writeFileSync(join(repo, ".rigwell", "worktree-setups", "r.yaml"), "name: Repo\nscript: touch ran.txt\n");
    const root = tmp("e2e-root");
    const r = await runSession(repo, root, idleScript(), { setupProfile: "r" });
    expect(r.init.worktree.setup.skipped).toMatch(/trusted/);
    expect(existsSync(join(r.init.worktree.path, "ran.txt"))).toBe(false);
    await finish(r.c);
  });

  test("auto-delete skips a worktree with uncommitted work", async () => {
    const repo = makeRepo();
    const root = tmp("e2e-root");
    const limit = { worktreeAutoDeleteLimit: 1 };
    const dirty = await runSession(repo, root, editScript("Hello, "), { prompt: "dirty one" }, {}, limit); // leaves an uncommitted edit
    const clean = await runSession(repo, root, idleScript(), { prompt: "clean one" }, {}, limit);
    const pd = dirty.init.worktree.path, pc = clean.init.worktree.path;
    await finish(dirty.c);
    await finish(clean.c);
    expect(gitOut(pd, "status", "--porcelain")).toContain("greet.js");

    // Age both so the 30 minute "recently used" guard does not apply (dirty is the older one).
    for (const [p, age] of [[pd, 3], [pc, 2]] as const) {
      const f = join(gitOut(p, "rev-parse", "--absolute-git-dir"), "rigwell-worktree.json");
      const m = JSON.parse(readFileSync(f, "utf8"));
      writeFileSync(f, JSON.stringify({ ...m, lastUsedAt: Date.now() - age * 3_600_000 }));
    }

    // Creating a third worktree runs the pass: 2 ephemeral > limit 1.
    const third = await runSession(repo, root, idleScript(), { prompt: "third one" }, {}, limit);
    expect(third.init.worktree.path).not.toBe(pd);
    expect(existsSync(pd)).toBe(true);   // skipped: uncommitted work
    expect(existsSync(pc)).toBe(false);  // removed: clean, least recently used among the removable
    expect(readFileSync(join(pd, "greet.js"), "utf8")).toContain('"Hello, "');
    await finish(third.c);
  });
});

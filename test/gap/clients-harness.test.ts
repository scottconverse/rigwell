// Gap wave: client handlers, harness side. A parked session adopted by a new connection gets its worktree hold back.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { closeHeadWatchers } from "../../src/worktree/connect.ts";
import { driver } from "./helpers.ts";

const servers: FakeServer[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); closeHeadWatchers(); });

test("a parked worktree session adopted by a new connection keeps its hold until that connection closes", async () => {
  const model = await startFakeAnthropic([{ toolCalls: [{ name: "Execute", input: { command: "echo hi", riskLevel: "medium", riskReason: "writes" } }] }, { text: "done" }]);
  servers.push(model);
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
  const root = mkdtempSync(join(tmpdir(), "rw-wt-root-"));
  const sf = join(home, "settings.json");
  writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), worktreeDirectory: root }));
  process.env.RIGWELL_HOME = home;
  const repo = makeRepo();

  const a = driver({ canPrompt: true, answer: () => new Promise(() => {}) });
  const init = await a.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low", worktree: { enabled: true, prompt: "park me" } });
  const wt = init.worktree.path as string;
  await a.call("add_user_message", { text: "go" });
  await a.until(() => a.requests.some((r) => r.method === "request_permission"));
  await a.conn.shutdown({ park: true });

  const b = driver({ canPrompt: true });
  const loaded = await b.call("load_session", { sessionId: init.sessionId, cwd: repo });
  expect(loaded.pendingPermissions.length).toBe(1);
  await expect(b.call("cleanup_worktree", { worktreePath: wt })).rejects.toThrow(/live session/);
  await b.call("answer_request", { requestId: loaded.pendingPermissions[0].requestId, answer: { selectedOption: "proceed_once" } });
  await b.until(() => b.completed().length >= 1);
  await b.call("close_session", {});
  const r = await b.call("cleanup_worktree", { worktreePath: wt });
  expect(r.removed).toBe(true);
  expect(existsSync(wt)).toBe(false);
}, 60000);

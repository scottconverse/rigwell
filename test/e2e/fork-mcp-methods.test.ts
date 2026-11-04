// fork_session, list/add/remove_mcp_server over the real protocol (in-process connection).
import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeHome, makeRepo } from "./helpers.ts";
import { inproc } from "./inproc.ts";

const FAKE_MCP = path.resolve(import.meta.dir, "../fakes/fake-mcp-server.ts");
const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

test("fork_session copies the transcript into a new session that loads; MCP server methods work", async () => {
  const model = await startFakeAnthropic([{ text: "first" }, { text: "forked answer" }]);
  servers.push(model);
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }]);
  const repo = makeRepo();
  const a = inproc();
  const init = await a.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0" });
  await a.turn("hello");
  expect((await a.call("list_mcp_servers", {})).summary.total).toBe(0);
  expect(await a.call("add_mcp_server", { name: "x", type: "stdio", command: process.execPath, args: [FAKE_MCP] })).toEqual({ success: true });
  expect((await a.call("list_mcp_servers", {})).servers[0]).toMatchObject({ name: "x", status: "connected" });
  expect(await a.call("remove_mcp_server", { serverName: "x", settingsLevel: "user" })).toEqual({ success: true });
  const { newSessionId } = await a.call("fork_session", { title: "my fork" });
  expect(newSessionId).not.toBe(init.sessionId);
  await a.call("close_session", {});

  const b = inproc();
  const loaded = await b.call("load_session", { sessionId: newSessionId, cwd: repo });
  expect(JSON.stringify(loaded.session.messages)).toContain("first");
  await b.turn("and now?");
  expect(JSON.stringify(model.requests.at(-1))).toContain("hello");
  await b.call("close_session", {});
}, 30000);

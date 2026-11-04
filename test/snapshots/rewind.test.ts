// File snapshots and rewind_session over the real protocol (in-process connection, fake model).
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { inproc } from "../e2e/inproc.ts";
import { evict, loadIndex, loadManifest, snapshotsDir } from "../../src/snapshots/index.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const edit = (p: string, a: string, b: string): FakeTurn => () => ({ toolCalls: [{ name: "Edit", input: { path: p, old_text: a, new_text: b } }] });
/** A turn that reads, edits and answers (Edit refuses a file the session has not read, or that changed since). */
const editTurn = (p: string, a: string, b: string, t: string): FakeTurn[] => [
  () => ({ toolCalls: [{ name: "Read", input: { path: p } }] }), edit(p, a, b), say(t),
];
const say = (t: string): FakeTurn => () => ({ text: t });

async function setup(script: FakeTurn[], extra: Record<string, unknown> = {}) {
  const model = await startFakeAnthropic(script);
  servers.push(model);
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }]);
  const repo = makeRepo();
  const c = inproc();
  const init = await c.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "high", toolExecutionMode: "direct_only", ...extra });
  return { model, repo, c, sessionId: init.sessionId as string };
}

async function turn(c: ReturnType<typeof inproc>, text: string, messageId: string) {
  const before = c.out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length;
  await c.call("add_user_message", { text, messageId });
  const t0 = Date.now();
  while (c.out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length <= before) {
    if (Date.now() - t0 > 20000) throw new Error("turn timeout");
    await Bun.sleep(2);
  }
}

test("edit over 3 turns; rewind to turn 2 restores the file and the next request drops turn 3", async () => {
  const { model, repo, c, sessionId } = await setup([
    ...editTurn("greet.js", "Helo", "Hello1", "done1"),
    ...editTurn("greet.js", "Hello1", "Hello2", "done2"),
    ...editTurn("greet.js", "Hello2", "Hello3", "done3"),
    say("after rewind"),
  ]);
  const f = path.join(repo, "greet.js");
  await turn(c, "turn one", "m1");
  await turn(c, "turn two", "m2");
  await turn(c, "turn three marker", "m3");
  expect(readFileSync(f, "utf8")).toContain("Hello3");
  const r = await c.call("rewind_session", { messageId: "m2", restoreFiles: true });
  expect(r.restoredFiles).toEqual([f]);
  expect(r.removedCount).toBeGreaterThan(0);
  expect(readFileSync(f, "utf8")).toContain("Hello1");
  await turn(c, "turn four", "m4");
  const body = JSON.stringify(model.requests.at(-1));
  expect(body).toContain("turn two");
  expect(body).not.toContain("turn three marker");
  expect(body).not.toContain("done2");
  await c.call("close_session", {});

  // load_session rebuilds from the rewind record; transcript lines are kept.
  const d = inproc();
  const loaded = await d.call("load_session", { sessionId, cwd: repo });
  const text = JSON.stringify(loaded.session.messages);
  expect(text).toContain("turn four");
  expect(text).not.toContain("turn three marker");
  const home = process.env.RIGWELL_HOME!;
  const rel = readdirSync(path.join(home, "sessions"), { recursive: true }).map(String).find((n) => n.endsWith(`${sessionId}.jsonl`))!;
  const raw = readFileSync(path.join(home, "sessions", rel), "utf8");
  expect(raw).toContain("turn three marker");
  expect(raw).toContain('"type":"rewind"');
  await d.call("close_session", {});
}, 60000);

test("a created file is removed on rewind", async () => {
  const { repo, c } = await setup([
    () => ({ toolCalls: [{ name: "Create", input: { path: "new/made.txt", content: "hi\n" } }] }), say("created"),
  ]);
  const f = path.join(repo, "new", "made.txt");
  await turn(c, "make a file", "u1");
  expect(existsSync(f)).toBe(true);
  const r = await c.call("rewind_session", { messageId: "u1", restoreFiles: true });
  expect(r.restoredFiles).toEqual([f]);
  expect(existsSync(f)).toBe(false);
  await c.call("close_session", {});
}, 30000);

test("an external change since the agent's last edit is refused unless forced; nothing is changed on refusal", async () => {
  const { repo, c, sessionId } = await setup([...editTurn("greet.js", "Helo", "Hello1", "done1")]);
  const f = path.join(repo, "greet.js");
  await turn(c, "one", "s1");
  writeFileSync(f, "changed by someone else\n");
  await expect(c.call("rewind_session", { messageId: "s1", restoreFiles: true })).rejects.toThrow(/changed outside the agent/);
  expect(readFileSync(f, "utf8")).toBe("changed by someone else\n");
  const r = await c.call("rewind_session", { messageId: "s1", restoreFiles: true, force: true });
  expect(r.restoredFiles).toEqual([f]);
  expect(readFileSync(f, "utf8")).toContain("Helo");
  expect(loadManifest(sessionId).boundaries.length).toBe(0);
  await c.call("close_session", {});
}, 30000);

test("ApplyPatch files (update, add, delete) are captured and restored by rewind", async () => {
  const patch = [
    "*** Begin Patch", "*** Update File: greet.js", "@@", '-  return "Helo, " + name + "!";', '+  return "Hello, " + name + "!";', "*** Add File: made/new.txt", "+fresh", "*** Delete File: gone.txt", "*** End Patch",
  ].join("\n");
  const { repo, c } = await setup([
    () => ({ toolCalls: [{ name: "Read", input: { path: "greet.js" } }, { name: "Read", input: { path: "gone.txt" } }] }),
    () => ({ toolCalls: [{ name: "ApplyPatch", input: { input: patch } }] }), say("patched"),
  ], { additionalToolIds: ["ApplyPatch"] });
  writeFileSync(path.join(repo, "gone.txt"), "keep me\n");
  const g = path.join(repo, "greet.js"), n = path.join(repo, "made", "new.txt"), d = path.join(repo, "gone.txt");
  const orig = readFileSync(g, "utf8");
  await turn(c, "patch it", "p1");
  expect(readFileSync(g, "utf8")).toContain("Hello");
  expect(existsSync(n)).toBe(true);
  expect(existsSync(d)).toBe(false);
  const r = await c.call("rewind_session", { messageId: "p1", restoreFiles: true });
  expect([...r.restoredFiles].sort()).toEqual([d, g, n].sort());
  expect(readFileSync(g, "utf8")).toBe(orig);
  expect(readFileSync(d, "utf8")).toBe("keep me\n");
  expect(existsSync(n)).toBe(false);
  await c.call("close_session", {});
}, 30000);

test("restoreFiles false leaves files alone; bad targets are rejected", async () => {
  const { repo, c } = await setup([...editTurn("greet.js", "Helo", "Hello1", "hi")]);
  const f = path.join(repo, "greet.js");
  await turn(c, "hello", "e1");
  await expect(c.call("rewind_session", { messageId: "nope" })).rejects.toThrow(/No such message/);
  await expect(c.call("rewind_session", { messageId: "" })).rejects.toThrow(/messageId is required/);
  await c.call("rewind_session", { messageId: "e1" });
  expect(readFileSync(f, "utf8")).toContain("Hello1");
  await c.call("close_session", {});
}, 30000);

test("eviction drops the oldest boundaries over the cap, deletes unreferenced blobs, and blocks restoring them", async () => {
  const { repo, c, sessionId } = await setup([
    ...editTurn("greet.js", "Helo", "Hello1", "a"), ...editTurn("greet.js", "Hello1", "Hello2", "b"), ...editTurn("greet.js", "Hello2", "Hello3", "c"),
  ]);
  process.env.RIGWELL_SNAPSHOT_MAX_BYTES = "100";
  try {
    await turn(c, "one", "v1");
    await turn(c, "two", "v2");
    await turn(c, "three", "v3");
  } finally {
    delete process.env.RIGWELL_SNAPSHOT_MAX_BYTES;
  }
  const m = loadManifest(sessionId);
  expect(m.evictedBoundaryCount).toBeGreaterThan(0);
  expect(m.oldestAvailableBoundaryIndex).toBe(m.evictedBoundaryCount);
  expect(m.boundaries.at(-1)!.messageId).toBe("v3");
  const idx = loadIndex();
  expect(idx.totalSizeBytes).toBeLessThanOrEqual(100);
  const blobs = readdirSync(path.join(snapshotsDir(), "content"), { recursive: true }).filter((n) => String(n).includes(path.sep));
  expect(blobs.length).toBe(new Set(idx.boundaryQueue.flatMap((e) => e.contentHashes)).size);
  await expect(c.call("rewind_session", { messageId: "v1", restoreFiles: true })).rejects.toThrow(/evicted/);
  expect(readFileSync(path.join(repo, "greet.js"), "utf8")).toContain("Hello3");
  await c.call("close_session", {});
}, 60000);

test("evict() never drops the boundary being written", () => {
  process.env.RIGWELL_HOME = makeHome([]);
  const idx = loadIndex();
  idx.boundaryQueue.push({ sessionId: "a", boundaryIndex: 0, timestamp: 1, sizeBytes: 100, contentHashes: [] });
  expect(evict(idx, 10, { sessionId: "a", boundaryIndex: 0 })).toBe(0);
  expect(idx.boundaryQueue.length).toBe(1);
});

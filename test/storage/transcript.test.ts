import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "../../src/core/types.ts";
import {
  appendMessage, appendTurnOutcome, createSession, findSession, listSessions, loadSession,
} from "../../src/storage/transcript.ts";
import { projectSlug } from "../../src/storage/paths.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
let cwd: string;
beforeEach(() => { env = tmpEnv(); cwd = path.join(env.root, "proj"); mkdirSync(cwd); });
afterEach(() => env.cleanup());

const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);

test("create writes session_start first; round trip with tool_use/tool_result/llm_only", async () => {
  const files = createSession({ id: "s1", cwd });
  expect(files.dir).toContain(projectSlug(cwd));
  const first = JSON.parse(lines(files.transcriptPath)[0]!);
  expect(first).toMatchObject({ type: "session_start", id: "s1", title: "New Session", version: 2, cwd });
  expect(typeof first.hostId).toBe("string");

  const ctx: Message = { id: "context-t1", role: "user", visibility: "llm_only", content: [{ type: "text", text: "reminder" }] };
  const user: Message = { id: "t1", role: "user", content: [{ type: "text", text: "hello" }] };
  const asst: Message = {
    id: "a1", role: "assistant", modelId: "custom:X-0", apiProvider: "anthropic", reasoningEffort: "high",
    content: [
      { type: "thinking", thinking: "hm", signature: "sig" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } },
    ],
    openaiReasoning: [{ id: "r1", encryptedContent: "enc", summary: "sum" }, { id: "r2" }],
  };
  const res: Message = { id: "r1m", role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "data", is_error: false }] };
  await appendMessage(files, ctx, null);
  await appendMessage(files, user, "context-t1");
  await appendMessage(files, asst, "t1");
  await appendMessage(files, res, "a1");
  await appendTurnOutcome(files, { turnId: "t1", reason: "completed", resultKind: "text" });

  const raw = lines(files.transcriptPath).map((l) => JSON.parse(l));
  expect(raw[3].message.content[1]).toEqual({ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } });
  expect(raw[3].message.openaiReasoningId).toBe("r1");
  expect(raw[3].message.openaiEncryptedContent).toBe("enc");
  expect(raw[3].seq).toBe(2);

  const loaded = loadSession("s1", cwd);
  expect(loaded.messages).toEqual([ctx, user, asst, res]);
  expect(loaded.outcomes).toEqual([{ type: "agent_turn_outcome", turnId: "t1", reason: "completed", resultKind: "text" }]);
  expect(loaded.messages[0]!.visibility).toBe("llm_only");
  // found from a different cwd too
  expect(findSession("s1", path.join(env.root, "other"))?.transcriptPath).toBe(files.transcriptPath);
});

test("concurrent appends are serialised: valid lines, seq strictly increasing, lock released", async () => {
  const files = createSession({ id: "c1", cwd });
  const N = 40;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      appendMessage(files, { id: `m${i}`, role: "user", content: [{ type: "text", text: "x".repeat(2000) + i }] }, null)),
  );
  const recs = lines(files.transcriptPath).map((l) => JSON.parse(l)); // throws on corruption
  const seqs = recs.filter((r) => r.type === "message").map((r) => r.seq);
  expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i));
  expect(existsSync(files.lockPath)).toBe(false);
});

test("a second SessionFiles handle (reload) continues the seq", async () => {
  const files = createSession({ id: "c2", cwd });
  await appendMessage(files, { id: "a", role: "user", content: [] }, null);
  const again = loadSession("c2", cwd).files;
  const seq = await appendMessage(again, { id: "b", role: "user", content: [] }, "a");
  expect(seq).toBe(1);
});

test("stale lock is stolen", async () => {
  const files = createSession({ id: "l1", cwd });
  writeFileSync(files.lockPath, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(files.lockPath, old, old);
  await appendMessage(files, { id: "a", role: "user", content: [] }, null);
  expect(loadSession("l1", cwd).messages.length).toBe(1);
});

test("loader skips garbage lines, tolerates unknown record types, requires session_start", async () => {
  const files = createSession({ id: "g1", cwd });
  await appendMessage(files, { id: "a", role: "user", content: [{ type: "text", text: "hi" }] }, null);
  appendFileSync(files.transcriptPath, "{not json\n" + JSON.stringify({ type: "todo_state", id: "t", todos: {} }) + "\n");
  const l = loadSession("g1", cwd);
  expect(l.messages.length).toBe(1);
  expect(l.skippedLines).toBe(1);
  expect(l.unknownRecords).toBe(1);

  writeFileSync(path.join(files.dir, "bad.jsonl"), JSON.stringify({ type: "message" }) + "\n");
  expect(() => loadSession("bad", cwd)).toThrow(/session_start/);
  expect(() => loadSession("../x", cwd)).toThrow();
  expect(() => loadSession("missing", cwd)).toThrow(/not found/);
});

test("create over an unloadable file recreates it", () => {
  const dirFiles = createSession({ id: "r1", cwd });
  writeFileSync(dirFiles.transcriptPath, "garbage\n");
  createSession({ id: "r1", cwd, title: "T" });
  expect(loadSession("r1", cwd).start.title).toBe("T");
});

test("listSessions sorts newest first and filters by cwd", async () => {
  const a = createSession({ id: "a", cwd, title: "A" });
  const cwd2 = path.join(env.root, "p2"); mkdirSync(cwd2);
  createSession({ id: "b", cwd: cwd2, title: "B" });
  const t = new Date(Date.now() - 100_000);
  utimesSync(a.transcriptPath, t, t);
  expect(listSessions().map((s) => s.id)).toEqual(["b", "a"]);
  expect(listSessions(cwd).map((s) => s.title)).toEqual(["A"]);
});

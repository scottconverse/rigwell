import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listSharedDocs, readSharedVersion, recordSharedFolder, recordSharedPath, restoreSharedVersion, sharedHistory,
} from "../../src/workstreams/shared-history.ts";
import { createWorkstreamService, wrapSharedRecording } from "../../src/workstreams/index.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { createCreateTool } from "../../src/tools/create.ts";
import { tmp } from "../worktree/util.ts";
import type { Session } from "../../src/agent/session.ts";

function shared() {
  const root = mkdtempSync(join(tmpdir(), "rigwell-sh-"));
  const sharedRoot = join(root, "ws", "shared");
  mkdirSync(sharedRoot, { recursive: true });
  return { root, sharedRoot };
}
const write = (sharedRoot: string, name: string, text: string | Buffer) => {
  const file = join(sharedRoot, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

test("recordSharedPath versions changed content and keeps the same id", () => {
  const { sharedRoot } = shared();
  const file = write(sharedRoot, "note.txt", "one");
  const first = recordSharedPath(sharedRoot, file, "Lead")!;
  expect(first.version).toBe(1); expect(first.id).toBeTruthy();
  expect(recordSharedPath(sharedRoot, file, "Lead")).toMatchObject({ id: first.id, version: 1 });
  writeFileSync(file, "two");
  expect(recordSharedPath(sharedRoot, file, "Member")).toMatchObject({ id: first.id, version: 2 });
  expect(sharedHistory(sharedRoot, "note.txt").versions.map((v) => v.by)).toEqual(["Member", "Lead"]);
});

test("recordSharedFolder labels pre-existing files and records later changes", () => {
  const { sharedRoot } = shared();
  write(sharedRoot, "a.txt", "alpha");
  write(sharedRoot, "b.txt", "beta");
  expect(recordSharedFolder(sharedRoot, "outside Rigwell")).toBe(2);
  expect(Object.fromEntries(listSharedDocs(sharedRoot).map((d) => [d.path, d.by]))).toEqual({ "a.txt": "existing file", "b.txt": "existing file" });
  write(sharedRoot, "a.txt", "alpha changed");
  expect(recordSharedFolder(sharedRoot, "Member")).toBe(1);
  expect(sharedHistory(sharedRoot, "a.txt").versions[0]).toMatchObject({ version: 2, by: "Member" });
});

test("a removed file gets a deleted version and lists as deleted", () => {
  const { sharedRoot } = shared();
  write(sharedRoot, "gone.txt", "bye");
  recordSharedFolder(sharedRoot, "Lead");
  rmSync(join(sharedRoot, "gone.txt"));
  expect(recordSharedFolder(sharedRoot, "outside Rigwell")).toBe(1);
  const doc = listSharedDocs(sharedRoot).find((d) => d.path === "gone.txt")!;
  expect(doc.deleted).toBe(true);
  expect(sharedHistory(sharedRoot, "gone.txt").versions[0]).toMatchObject({ deleted: true, bytes: 0 });
});

test("identical content in two files shares one blob", () => {
  const { root, sharedRoot } = shared();
  const same = "same bytes";
  recordSharedPath(sharedRoot, write(sharedRoot, "one.txt", same), "Lead");
  recordSharedPath(sharedRoot, write(sharedRoot, "two.txt", same), "Lead");
  expect(readdirSync(join(root, "ws", "shared-history", "blobs"))).toHaveLength(1);
});

test("a file over the size limit keeps a version but no copy, so restore throws", () => {
  const { sharedRoot } = shared();
  process.env.RIGWELL_SHARED_HISTORY_MAX_BYTES = "10";
  try {
    const file = write(sharedRoot, "big.txt", "x".repeat(20));
    expect(recordSharedPath(sharedRoot, file, "Lead")).toMatchObject({ version: 1 });
    expect(readSharedVersion(sharedRoot, "big.txt", 1)).toEqual({ stored: false, bytes: 20 });
    expect(() => restoreSharedVersion(sharedRoot, "big.txt", 1)).toThrow("no saved copy");
  } finally { delete process.env.RIGWELL_SHARED_HISTORY_MAX_BYTES; }
});

test("readSharedVersion returns text as content and binary as base64", () => {
  const { sharedRoot } = shared();
  recordSharedPath(sharedRoot, write(sharedRoot, "text.txt", "hello"), "Lead");
  expect(readSharedVersion(sharedRoot, "text.txt", 1)).toMatchObject({ stored: true, content: "hello" });
  const binary = Buffer.from([1, 0, 2, 3]);
  recordSharedPath(sharedRoot, write(sharedRoot, "blob.bin", binary), "Lead");
  const read = readSharedVersion(sharedRoot, "blob.bin", 1);
  expect(read.content).toBeUndefined();
  expect(Buffer.from(read.base64!, "base64").equals(binary)).toBe(true);
});

test("restoreSharedVersion writes the old bytes and adds a new version", () => {
  const { sharedRoot } = shared();
  const file = write(sharedRoot, "note.txt", "v1");
  recordSharedPath(sharedRoot, file, "Lead");
  writeFileSync(file, "v2");
  recordSharedPath(sharedRoot, file, "Lead");
  expect(restoreSharedVersion(sharedRoot, "note.txt", 1)).toMatchObject({ version: 3 });
  expect(readFileSync(file, "utf8")).toBe("v1");
  expect(sharedHistory(sharedRoot, "note.txt").versions[0]).toMatchObject({ version: 3, by: "user (restored version 1)" });
});

test("paths that leave the shared folder are refused", () => {
  const { sharedRoot } = shared();
  for (const path of ["../x", "/x", "a/../../x"]) {
    expect(() => sharedHistory(sharedRoot, path)).toThrow("Path must stay inside the shared folder");
  }
});

test("the lead's Create into the shared folder is recorded and shared-history is refused", async () => {
  process.env.RIGWELL_HOME = tmp("ws-sh-home");
  const cwd = tmp("ws-sh-cwd"), service = createWorkstreamService({ recover: false });
  const session = { id: crypto.randomUUID(), cwd, uiMessages: () => [], settings: { modelId: "test", reasoningEffort: "low", autonomyLevel: "low" } } as unknown as Session;
  const conn = { session: () => session, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) };
  const attached = service.attach(conn);
  try {
    const approved = await service.propose(conn, { title: "Shared", goal: "Record files", plan: "Write notes" });
    const store = new WorkstreamStore(approved.workstreamId!);
    const create = attached.wrapTools([createCreateTool()]).find((t) => t.name === "Create")!;
    const ctx = { cwd, sessionId: session.id, readFiles: new Map(), signal: new AbortController().signal };
    const saved = await create.run({ path: join(store.path("shared"), "note.txt"), content: "hello" }, ctx);
    expect(saved.isError).toBeFalsy();
    expect(JSON.parse(saved.content).sharedDocument.version).toBe(1);
    const refused = await create.run({ path: join(store.path("shared-history"), "index.json"), content: "{}" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("managed by Rigwell");
  } finally { attached.close(); await service.stop(); }
});

test("wrapSharedRecording leaves other tools untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "rigwell-sh-store-")), store = new WorkstreamStore("ws", root);
  store.create({ id: "ws", title: "t", goal: "g", plan: "p", leadSessionId: "lead", cwd: root, state: "active", createdAt: 1, updatedAt: 1, settings: { enabled: true, maxConcurrentAgents: 1, allowNestedSpawn: false, autoRejectMemberPrompts: false } });
  const other = { name: "Read", description: "", inputSchema: {}, category: "read" as const, run: async () => ({ content: "ok" }) };
  expect(wrapSharedRecording(other, store, "Lead")).toBe(other);
});

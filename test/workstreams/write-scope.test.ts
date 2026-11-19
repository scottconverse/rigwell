import { expect, test } from "bun:test";
import { linkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../../src/core/types.ts";
import { createApplyPatchTool } from "../../src/tools/apply-patch.ts";
import { createCreateTool } from "../../src/tools/create.ts";
import { approvedWriteScopes, guardMemberWrites } from "../../src/workstreams/write-scope.ts";
import { tmp } from "../worktree/util.ts";

test("write assignments reject traversal, alternate streams and missing member boundaries", () => {
  expect(approvedWriteScopes([{ name: "Parser", writeFiles: ["src\\csv.js"] }, { name: "Reviewer", writeFiles: [] }])).toEqual([
    { name: "Parser", writeFiles: ["src/csv.js"] }, { name: "Reviewer", writeFiles: [] },
  ]);
  for (const path of ["../other", "/abs", "C:\\abs", "own.txt:stream", ".git/config", "docs.", "aux.log"]) {
    expect(() => approvedWriteScopes([{ name: "Parser", writeFiles: [path] }])).toThrow("Unsafe or non-relative");
  }
  expect(() => approvedWriteScopes([{ name: "Parser", writeFiles: [] }, { name: "Reviewer" }])).toThrow("every member");
});

test("mixed patches and hard-linked destinations are denied before any write", async () => {
  const cwd = tmp("ws-write-scope"), outside = join(tmp("ws-write-source"), "outside.txt");
  writeFileSync(outside, "intact");
  linkSync(outside, join(cwd, "linked.txt"));
  const ctx: ToolContext = { cwd, sessionId: "test", readFiles: new Map(), signal: new AbortController().signal };
  const denials: string[][] = [];
  const denied = (paths: string[]) => denials.push(paths);
  const create = guardMemberWrites(createCreateTool(), ["linked.txt"], denied);
  expect((await create.run({ path: "linked.txt", overwrite: true, content: "unexpected" }, ctx)).isError).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("intact");

  const patch = guardMemberWrites(createApplyPatchTool(), ["owned.txt"], denied);
  const input = "*** Begin Patch\n*** Add File: owned.txt\n+permitted\n*** Add File: unassigned.txt\n+denied\n*** End Patch";
  expect((await patch.run({ input }, ctx)).isError).toBe(true);
  expect(() => readFileSync(join(cwd, "owned.txt"))).toThrow();
  expect(denials).toEqual([["linked.txt"], ["owned.txt", "unassigned.txt"]]);
});

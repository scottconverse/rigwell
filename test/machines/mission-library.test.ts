import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { mergeMissionLibrary } from "../../src/machines/mission-worker.ts";

test("remote mission library transfers changes and deletions while preserving concurrent local edits", () => {
  const env = tmpEnv(), dir = join(env.root, "mission");
  mkdirSync(join(dir, "library"), { recursive: true });
  const read = (p: string) => readFileSync(join(dir, "library", p), "utf8");
  const write = (p: string, content: string) => writeFileSync(join(dir, "library", p), content);
  try {
    write("original.md", "before"); write("remove.md", "old"); write("local.md", "local-only");
    const baseline = { "library/original.md": "before", "library/remove.md": "old" };
    const snapshot = { "library/original.md": "remote update", "library/new.md": "remote addition" };
    expect(mergeMissionLibrary(dir, baseline, snapshot)).toEqual(snapshot);
    expect(read("original.md")).toBe("remote update"); expect(read("new.md")).toBe("remote addition");
    expect(existsSync(join(dir, "library/remove.md"))).toBe(false); expect(read("local.md")).toBe("local-only");
    write("original.md", "concurrent local edit");
    expect(() => mergeMissionLibrary(dir, snapshot, { "library/new.md": "must not apply", "library/original.md": "conflicting remote edit" })).toThrow("Mission library conflict");
    expect(read("new.md")).toBe("remote addition"); expect(read("original.md")).toBe("concurrent local edit");
    for (const bad of [{ "../escape.md": "x" }, { "library/../features.json": "x" }, { "features.json": "x" }, { "library/n.md": 1 }]) expect(() => mergeMissionLibrary(dir, {}, bad)).toThrow("Invalid remote mission library file");
  } finally { env.cleanup(); }
});

test("remote mission notes cannot write through a broken directory link", () => {
  const env = tmpEnv(), dir = join(env.root, "mission"), outside = join(env.root, "outside");
  mkdirSync(join(dir, "library"), { recursive: true });
  try {
    symlinkSync(outside, join(dir, "library", "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => mergeMissionLibrary(dir, {}, { "library/linked/note.md": "must not escape" })).toThrow("must not be linked");
    expect(existsSync(outside)).toBe(false);
  } finally { env.cleanup(); }
});

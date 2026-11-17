import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SharedNotes } from "../../src/machines/shared-notes.ts";
import { tmpEnv } from "../storage/helpers.ts";

test("remote shared-file requests reject traversal, linked escapes, dangling links and tool-cap bypass", async () => {
  const env = tmpEnv(), root = join(env.root, "shared"), outside = join(env.root, "outside");
  mkdirSync(root); mkdirSync(outside); writeFileSync(join(outside, "private.txt"), "fixture");
  symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(join(outside, "new.txt"), join(root, "dangling"), "file");
  const notes = new SharedNotes(root, crypto.randomUUID());
  const rejected = async (name: string, path: string) => {
    let error: unknown;
    try { await notes.run(name, { path, content: "forbidden" }); } catch (e) { error = e; }
    expect(error).toBeDefined();
  };
  try {
    await rejected("Read", join(root, "..", "outside", "private.txt"));
    await rejected("Read", join(root, "escape", "private.txt"));
    await rejected("Create", join(root, "dangling"));
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    let error: unknown; try { await new SharedNotes(root, "fixture", ["Read"]).run("Create", { path: join(root, "new.txt"), content: "forbidden" }); } catch (e) { error = e; }
    expect(error).toBeDefined(); expect(existsSync(join(root, "new.txt"))).toBe(false);
  } finally { env.cleanup(); }
});

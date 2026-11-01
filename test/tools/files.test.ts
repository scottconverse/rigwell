import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createCreateTool } from "../../src/tools/create.ts";
import { createEditTool } from "../../src/tools/edit.ts";
import { createReadTool } from "../../src/tools/read.ts";
import { makeCtx, tmpDir } from "./helpers.ts";

const read = createReadTool();
const edit = createEditTool();
const create = createCreateTool();

describe("Read", () => {
  test("reads lines, offset/limit, line numbers, records the read", async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "a.txt"), "one\ntwo\nthree\n");
    const ctx = makeCtx(d);
    const r = await read.run({ path: "a.txt", offset: 2, limit: 1, lineNumbers: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("     2\ttwo");
    expect(r.content).toContain("of 3");
    expect(r.content).toContain("More lines remain");
    expect(ctx.readFiles.has(path.join(d, "a.txt"))).toBe(true);
  });
  test("cuts long lines; refuses directory, binary, image", async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "long.txt"), "x".repeat(2500));
    fs.writeFileSync(path.join(d, "b.bin"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(d, "i.png"), "x");
    const ctx = makeCtx(d);
    expect((await read.run({ path: "long.txt" }, ctx)).content).toContain("line cut");
    expect((await read.run({ path: "." }, ctx)).content).toContain("directory");
    expect((await read.run({ path: "b.bin" }, ctx)).isError).toBe(true);
    expect((await read.run({ path: "i.png" }, ctx)).content).toContain("not supported");
  });
});

describe("Edit", () => {
  test("requires a prior read", async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "f.txt"), "hello\n");
    const r = await edit.run({ path: "f.txt", old_text: "hello", new_text: "bye" }, makeCtx(d));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not been read");
  });
  test("edits after read and keeps record fresh for a second edit", async () => {
    const d = tmpDir();
    const f = path.join(d, "f.txt");
    fs.writeFileSync(f, "hello\nworld\n");
    const ctx = makeCtx(d);
    await read.run({ path: f }, ctx);
    const r = await edit.run({ path: f, old_text: "hello", new_text: "bye\nbye2" }, ctx);
    expect(JSON.parse(r.content)).toMatchObject({ replacements: 1, linesAdded: 2, linesRemoved: 1 });
    expect(fs.readFileSync(f, "utf8")).toBe("bye\nbye2\nworld\n");
    expect((await edit.run({ path: f, old_text: "world", new_text: "w" }, ctx)).isError).toBeFalsy();
  });
  test("refuses a stale file", async () => {
    const d = tmpDir();
    const f = path.join(d, "f.txt");
    fs.writeFileSync(f, "hello\n");
    const ctx = makeCtx(d);
    await read.run({ path: f }, ctx);
    fs.writeFileSync(f, "hello there\n");
    const r = await edit.run({ path: f, old_text: "hello", new_text: "x" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("changed since you read it");
  });
  test("unique match rules and replaceAll", async () => {
    const d = tmpDir();
    const f = path.join(d, "f.txt");
    fs.writeFileSync(f, "a a a\n");
    const ctx = makeCtx(d);
    await read.run({ path: f }, ctx);
    expect((await edit.run({ path: f, old_text: "a", new_text: "b" }, ctx)).content).toContain("3 times");
    expect((await edit.run({ path: f, old_text: "zzz", new_text: "b" }, ctx)).content).toContain("not found");
    expect((await edit.run({ path: f, old_text: "a", new_text: "a" }, ctx)).isError).toBe(true);
    const r = await edit.run({ path: f, old_text: "a", new_text: "b", replaceAll: true }, ctx);
    expect(JSON.parse(r.content).replacements).toBe(3);
    expect(fs.readFileSync(f, "utf8")).toBe("b b b\n");
  });
});

describe("Create", () => {
  test("creates with parent dirs; refuses existing unless read + overwrite", async () => {
    const d = tmpDir();
    const ctx = makeCtx(d);
    const r = await create.run({ path: "x/y/z.txt", content: "a\nb\n" }, ctx);
    expect(JSON.parse(r.content)).toMatchObject({ bytes: 4, lines: 2 });
    const again = await create.run({ path: "x/y/z.txt", content: "c" }, makeCtx(d));
    expect(again.isError).toBe(true);
    expect(again.content).toContain("already exists");
    const noRead = await create.run({ path: "x/y/z.txt", content: "c", overwrite: true }, makeCtx(d));
    expect(noRead.content).toContain("not been read");
    const ok = await create.run({ path: "x/y/z.txt", content: "c", overwrite: true }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(d, "x/y/z.txt"), "utf8")).toBe("c");
  });
});

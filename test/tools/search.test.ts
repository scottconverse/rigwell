import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGlobTool } from "../../src/tools/glob.ts";
import { createGrepTool } from "../../src/tools/grep.ts";
import { createCoreTools, toolsForSession } from "../../src/tools/registry.ts";
import { makeCtx, tmpDir } from "./helpers.ts";

function fixture() {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src/a.ts"), "const Foo = 1;\nconst bar = 2;\n");
  fs.writeFileSync(path.join(d, "src/b.js"), "foo();\n");
  fs.writeFileSync(path.join(d, ".gitignore"), "ignored.ts\n");
  fs.writeFileSync(path.join(d, "ignored.ts"), "Foo\n");
  return d;
}

describe("Grep", () => {
  const grep = createGrepTool();
  test("files, content, count, and no match", async () => {
    const d = fixture();
    const ctx = makeCtx(d);
    const files = await grep.run({ pattern: "foo", ignoreCase: true }, ctx);
    expect(files.content).toContain("src/a.ts");
    expect(files.content).toContain("src/b.js");
    expect(files.content).not.toContain("ignored.ts");
    const content = await grep.run({ pattern: "bar", output: "content", glob: "*.ts" }, ctx);
    expect(content.content).toContain("src/a.ts:2:const bar = 2;");
    const count = await grep.run({ pattern: "const", output: "count", path: "src" }, ctx);
    expect(count.content).toContain("src/a.ts:2");
    const none = await grep.run({ pattern: "zzzz" }, ctx);
    expect(none.isError).toBeFalsy();
    expect(none.content).toContain("No matches");
  });
  test("limit cuts and says so; bad regex is an error", async () => {
    const d = fixture();
    const r = await grep.run({ pattern: "o", output: "content", limit: 1 }, makeCtx(d));
    expect(r.content).toContain("Results cut at 1");
    expect((await grep.run({ pattern: "(" }, makeCtx(d))).isError).toBe(true);
  });
});

describe("Glob", () => {
  const glob = createGlobTool();
  test("matches, respects gitignore, newest first, limit", async () => {
    const d = fixture();
    const old = new Date(Date.now() - 100_000);
    fs.utimesSync(path.join(d, "src/a.ts"), old, old);
    const ctx = makeCtx(d);
    const r = await glob.run({ pattern: "**/*.{ts,js}" }, ctx);
    const lines = r.content.split("\n");
    expect(lines[0]).toBe(path.join(d, "src/b.js"));
    expect(r.content).not.toContain("ignored.ts");
    const all = await glob.run({ pattern: "*.ts", includeIgnored: true }, ctx);
    expect(all.content).toContain("ignored.ts");
    const lim = await glob.run({ pattern: "**/*.{ts,js}", limit: 1 }, ctx);
    expect(lim.content).toContain("1 newest of 2");
  });
});

describe("registry", () => {
  test("order, gating, skipPermissions schema", () => {
    const browsers = ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_wait", "browser_evaluate", "browser_close"];
    expect(createCoreTools().map((t) => t.name)).toEqual(["Read", "LS", "Execute", "Grep", "Glob", "FetchUrl", ...browsers, "Edit", "Create"]);
    expect(toolsForSession({ autonomy: "off", skipPermissions: false }).map((t) => t.name)).toEqual(["Read", "LS", "Execute", "Grep", "Glob", "FetchUrl", ...browsers]);
    expect(toolsForSession({ autonomy: "low", skipPermissions: false }).length).toBe(18);
    expect(toolsForSession({ autonomy: "low", skipPermissions: false, fileEditProfile: "apply-patch" }).map((t) => t.name)).toEqual(["Read", "LS", "Execute", "Grep", "Glob", "FetchUrl", ...browsers, "ApplyPatch"]);
    const tools = toolsForSession({ autonomy: "off", skipPermissions: true });
    expect(tools.length).toBe(18);
    const ex = tools.find((t) => t.name === "Execute")!;
    expect(Object.keys((ex.inputSchema as any).properties)).not.toContain("riskLevel");
    expect((ex.inputSchema as any).required).toEqual(["command"]);
    const normal = createCoreTools().find((t) => t.name === "Execute")!;
    expect((normal.inputSchema as any).required).toContain("riskLevel");
  });
});

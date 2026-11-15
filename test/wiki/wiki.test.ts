import { expect, test } from "bun:test";
import { wikiFixture } from "./fixture.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { buildWiki, readWikiIndex, readWikiPage, searchWiki, wikiPath, withWikiLock } from "../../src/wiki/wiki.ts";
import { wikiWalkthrough } from "../../src/wiki/video.ts";
import { CLI } from "../e2e/helpers.ts";

test("wiki observes real declarations/imports, updates only affected pages, and removes deleted modules", async () => {
  const env = tmpEnv();
  try {
    const { project } = wikiFixture(env.root), first = await buildWiki(project);
    expect(first.index.modules).toBe(2); expect(first.changed).toHaveLength(5); expect(first.index.files).toBe(4);
    expect(readWikiPage(project, "overview.md")).toContain("small arithmetic library");
    expect(readWikiPage(project, "architecture.md")).toContain("ui depends on core");
    expect(readWikiPage(project, "glossary.md")).toContain("core/math.ts:1");
    const core = first.index.pages.find((p) => p.title === "Module: core")!, ui = first.index.pages.find((p) => p.title === "Module: ui")!;
    expect(readWikiPage(project, core.file)).toContain("clamp"); expect(searchWiki(project, "render").pages.some((p) => p.file === ui.file)).toBe(true);
    expect(searchWiki(project, "evidence-value").pages).toHaveLength(0); expect(searchWiki(project, "env-value").pages).toHaveLength(0); expect(searchWiki(project, "ignored-value").pages).toHaveLength(0);
    for (const p of first.index.pages) utimesSync(wikiPath(project, p.file), 1000, 1000);
    const unchanged = await buildWiki(project); expect(unchanged.changed).toEqual([]);
    writeFileSync(join(project, "core/math.ts"), "export function clamp(n: number) { return Math.max(1, n); }\n");
    const update = await buildWiki(project); expect(update.changed).toContain(core.file); expect(update.changed).not.toContain(ui.file); expect(statSync(wikiPath(project, ui.file)).mtimeMs).toBe(1_000_000);
    expect(statSync(wikiPath(project, core.file)).mtimeMs).toBeGreaterThan(1_000_000);
    writeFileSync(wikiPath(project, "notes.md"), "Owner notes"); rmSync(join(project, "ui/index.ts"));
    const removed = await buildWiki(project); expect(removed.removed).toEqual([ui.file]); expect(existsSync(wikiPath(project, ui.file))).toBe(false); expect(readFileSync(wikiPath(project, "notes.md"), "utf8")).toBe("Owner notes");
  } finally { env.cleanup(); }
});

test("commit polling skips unchanged HEAD while explicit update includes working tree edits", async () => {
  const env = tmpEnv();
  try {
    const { project, git } = wikiFixture(env.root); await buildWiki(project);
    writeFileSync(join(project, "core/math.ts"), "export function revised() { return 2; }\n");
    expect((await buildWiki(project, { afterCommit: true })).skipped).toBe(true); expect(readWikiPage(project, "glossary.md")).not.toContain("revised");
    await buildWiki(project); expect(readWikiPage(project, "glossary.md")).toContain("revised");
    git("add", "core/math.ts"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "revise fixture");
    expect((await buildWiki(project, { afterCommit: true })).skipped).toBe(false); expect(readWikiIndex(project)!.head).toBe(git("rev-parse", "HEAD"));
    expect((await buildWiki(project, { afterCommit: true })).skipped).toBe(true);
  } finally { env.cleanup(); }
});

test("unmanaged pages, source links, wiki links, escapes and simultaneous writers cannot acquire authority", async () => {
  const env = tmpEnv();
  try {
    const { project } = wikiFixture(env.root); mkdirSync(wikiPath(project), { recursive: true }); writeFileSync(wikiPath(project, "overview.md"), "Owner text");
    const collision = await buildWiki(project).catch((e) => e); expect(collision.message).toContain("unmanaged"); expect(readFileSync(wikiPath(project, "overview.md"), "utf8")).toBe("Owner text"); rmSync(wikiPath(project, "overview.md"));
    symlinkSync(join(project, "core/math.ts"), join(project, "linked.ts"), "file");
    const linked = await buildWiki(project).catch((e) => e); expect(linked.message).toContain("source links"); rmSync(join(project, "linked.ts"));
    expect(() => wikiPath(project, "../escape.md")).toThrow("Invalid");
    await withWikiLock(project, async () => { const busy = await buildWiki(project).catch((e) => e); expect(busy.message).toContain("busy"); });
    rmSync(wikiPath(project), { recursive: true }); const outside = join(env.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(project, ".rigwell/wiki"), process.platform === "win32" ? "junction" : "dir");
    const escape = await buildWiki(project).catch((e) => e); expect(escape.message).toContain("links"); expect(readdirSync(outside)).toEqual([]);
  } finally { env.cleanup(); }
});

test("offline walkthrough escapes project markup and fake local narration/rendering owns its temporary files", async () => {
  const env = tmpEnv();
  try {
    const { project } = wikiFixture(env.root); await buildWiki(project);
    const html = await wikiWalkthrough(project); const text = readFileSync(html.html, "utf8"); expect(text).toContain("Content-Security-Policy"); expect(text).not.toContain("<script>"); expect(text).toContain("page-4"); expect(html.video).toBeUndefined();
    const font = join(env.root, "font.ttf"); writeFileSync(font, "fake-font"); const calls: string[][] = [];
    const tools = { ffmpeg: "fake-ffmpeg", speech: { kind: "windows" as const, command: "fake-speech" }, font };
    const result = await wikiWalkthrough(project, { mp4: true, tools, run: async (command, args, cwd) => {
      calls.push([command, ...args]);
      if (command === "fake-speech") { expect(readFileSync(join(cwd, "speak.ps1"), "utf8")).toContain("SetOutputToWaveFile"); expect(existsSync(join(cwd, "narration.txt"))).toBe(true); writeFileSync(join(cwd, "narration.wav"), "fake-audio"); }
      else { expect(args).toContain("-nostdin"); writeFileSync(join(cwd, args.at(-1)!), "fake-video"); }
    } });
    expect(readFileSync(result.video!, "utf8")).toBe("fake-video"); expect(result.pages).toHaveLength(4); expect(calls.filter((c) => c[0] === "fake-speech")).toHaveLength(4); expect(readdirSync(wikiPath(project)).some((n) => n.startsWith("video-"))).toBe(false);
    const failure = await wikiWalkthrough(project, { mp4: true, tools, run: async () => { throw new Error("fake renderer failed"); } }).catch((e) => e); expect(failure.message).toContain("fake renderer failed"); expect(readdirSync(wikiPath(project)).some((n) => n.startsWith("video-"))).toBe(false); expect(existsSync(wikiPath(project, ".lock"))).toBe(false);
  } finally { env.cleanup(); }
});

test("real wiki CLI builds, searches, reads, exports and updates a temporary repository headlessly", async () => {
  const env = tmpEnv();
  try {
    const { project } = wikiFixture(env.root);
    const run = async (...args: string[]) => { const p = Bun.spawn([process.execPath, CLI, "wiki", ...args, "--cwd", project], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(), error = await new Response(p.stderr).text(); expect(await p.exited).toBe(0); expect(error).toBe(""); return out; };
    expect(JSON.parse(await run("build")).changed).toHaveLength(5); expect(JSON.parse(await run("search", "clamp")).pages.length).toBeGreaterThan(0); expect(await run("read", "glossary.md")).toContain("clamp");
    expect(JSON.parse(await run("update")).changed).toEqual([]); expect(existsSync(JSON.parse(await run("video")).html)).toBe(true);
  } finally { env.cleanup(); }
});

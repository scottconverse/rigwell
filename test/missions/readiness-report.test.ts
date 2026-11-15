import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { readinessPlan, generateReadinessReport, readReadinessReport } from "../../src/missions/readiness-report.ts";
import { acknowledgeFolder, checkReadiness } from "../../src/missions/readiness.ts";
import { createMissionService } from "../../src/missions/index.ts";
import type { Session } from "../../src/agent/session.ts";
const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, sessionId: "readiness-fixture", readFiles: new Map(), signal });
const command = (code: string) => `bun -e '${code}'`;
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
function repo(cwd: string) { git(cwd, ["init"]); git(cwd, ["config", "user.email", "fixture@example.invalid"]); git(cwd, ["config", "user.name", "Fixture"]); writeFileSync(join(cwd, "file.txt"), "fixture"); git(cwd, ["add", "."]); git(cwd, ["commit", "-m", "Fixture"]); git(cwd, ["remote", "add", "origin", "https://example.invalid/fixture.git"]); }

test("actual local readiness commands retain unknowns, failures, tools and commit identity without raw output", async () => {
  const e = tmpEnv(); try {
    repo(e.root); expect(readReadinessReport(e.root).report).toBeNull(); expect(checkReadiness(e.root).status).toBe("no_report");
    const unknown = await generateReadinessReport(e.root, {}, ctx(e.root)); expect(unknown.level).toBe(2); expect(unknown.checks.map((c) => c.status)).toEqual(["not_checked", "not_checked"]);
    const success = await generateReadinessReport(e.root, { buildCommand: command('console.log("secret-output-not-retained")'), testCommand: command("process.exit(0)"), tools: ["bun"] }, ctx(e.root)); expect(success.level).toBe(4); expect(success.checks.every((c) => c.exitCode === 0)).toBe(true); expect(success.tools.every((t) => t.status === "passed")).toBe(true); expect(checkReadiness(e.root).status).toBe("ok"); expect(readFileSync(join(e.root, ".rigwell/readiness-report.json"), "utf8")).not.toContain('stdout');
    const failed = await generateReadinessReport(e.root, { buildCommand: command("process.exit(7)"), testCommand: command("process.exit(0)"), tools: ["rigwell-missing-fixture-executable"] }, ctx(e.root)); expect(failed.level).toBe(2); expect(failed.checks[0]!.exitCode).toBe(7); expect(failed.checks[1]!.status).toBe("passed"); expect(failed.tools.find((t) => t.name === "rigwell-missing-fixture-executable")?.status).toBe("failed"); expect(checkReadiness(e.root).status).toBe("low_score");
    await generateReadinessReport(e.root, { buildCommand: command("process.exit(0)"), testCommand: command("process.exit(0)") }, ctx(e.root)); writeFileSync(join(e.root, "file.txt"), "changed"); git(e.root, ["add", "file.txt"]); git(e.root, ["commit", "-m", "Change"]); expect(checkReadiness(e.root).detail).toContain("current commit");
    acknowledgeFolder(e.root); expect(checkReadiness(e.root).detail).toBe("acknowledged");
  } finally { e.cleanup(); }
}, 20000);

test("readiness approval cancels without commands/writes, refuses unattended, and accepted tool runs actual commands", async () => {
  const e = tmpEnv(); try {
    repo(e.root); const s = { id: "readiness-fixture", cwd: e.root, settings: { interactionMode: "auto" } } as Session;
    const service = createMissionService(), approvals: any[] = []; let accept = false;
    const attached = service.attach({ session: () => s, notify() {}, request: async (method, params) => { approvals.push({ method, params }); return { selectedOption: accept ? "proceed_once" : "cancel" }; } });
    const tool = attached.wrapTools([]).find((t) => t.name === "ReadinessReport")!, plan = { buildCommand: command('require("fs").writeFileSync("approved-marker","yes")'), testCommand: command("process.exit(0)") };
    expect((await tool.run(plan, ctx(e.root))).data).toEqual({ cancelled: true }); expect(existsSync(join(e.root, "approved-marker"))).toBe(false); expect(readReadinessReport(e.root).report).toBeNull(); expect(approvals[0].params.toolUses[0].toolUse.input.buildCommand).toBe(plan.buildCommand);
    const unattended = service.attach({ session: () => s, notify() {} }).wrapTools([]).find((t) => t.name === "ReadinessReport")!; expect((await unattended.run(plan, ctx(e.root))).isError).toBe(true); expect(existsSync(join(e.root, "approved-marker"))).toBe(false);
    accept = true; const result = await tool.run(plan, ctx(e.root)); expect((result.data as any).level).toBe(4); expect(readFileSync(join(e.root, "approved-marker"), "utf8")).toBe("yes"); expect((attached.methods.mission_readiness_report!({}) as any).readiness.status).toBe("ok");
    const abort = new AbortController(); abort.abort(); expect((await tool.run(plan, ctx(e.root, abort.signal))).data).toEqual({ cancelled: true });
    const waiting = new AbortController(), never = service.attach({ session: () => s, notify() {}, request: () => new Promise(() => {}) }).wrapTools([]).find((t) => t.name === "ReadinessReport")!;
    const pending = never.run(plan, ctx(e.root, waiting.signal)); waiting.abort(); expect((await pending).data).toEqual({ cancelled: true });
  } finally { e.cleanup(); }
}, 20000);

test("readiness validates bounded plans and refuses linked report paths before any command", async () => {
  const e = tmpEnv(); try {
    for (const p of [null, [], { unexpected: true }, { tools: ["../bad"] }, { tools: ["x; echo unsafe"] }, { timeoutMs: 0 }, { buildCommand: "" }]) expect(() => readinessPlan(p)).toThrow();
    const target = join(e.root, "outside"); mkdirSync(target); symlinkSync(target, join(e.root, ".rigwell"), process.platform === "win32" ? "junction" : "dir");
    const error = await generateReadinessReport(e.root, { buildCommand: command('require("fs").writeFileSync("should-not-run","bad")') }, ctx(e.root)).then(() => null, (e) => e); expect(error.message).toContain("unlinked"); expect(existsSync(join(e.root, "should-not-run"))).toBe(false); expect(() => readReadinessReport(e.root)).toThrow("unlinked");
  } finally { e.cleanup(); }
});

test("real CLI reads without execution, runs only with explicit flag, returns failed status and bounds timeout", async () => {
  const e = tmpEnv(); try {
    repo(e.root); const cli = resolve(import.meta.dir, "../../src/cli/main.ts");
    const run = async (args: string[]) => { const p = Bun.spawn([process.execPath, cli, "readiness-report", "--cwd", e.root, ...args], { cwd: e.root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" }); const [exit, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { exit, out, err }; };
    const build = command('require("fs").writeFileSync("cli-marker","yes")');
    const read = await run(["--build", build]); expect(read.exit).toBe(0); expect(JSON.parse(read.out).report).toBeNull(); expect(existsSync(join(e.root, "cli-marker"))).toBe(false);
    const done = await run(["--build", build, "--test", command("process.exit(0)"), "--run"]); expect(done.exit).toBe(0); expect(JSON.parse(done.out).level).toBe(4); expect(readFileSync(join(e.root, "cli-marker"), "utf8")).toBe("yes");
    const failed = await run(["--test", command("process.exit(9)"), "--run"]); expect(failed.exit).toBe(1); expect(JSON.parse(failed.out).checks[1].exitCode).toBe(9);
    const timed = await run(["--build", command("setTimeout(()=>{},10000)"), "--timeout-ms", "200", "--run"]); expect(timed.exit).toBe(1); expect(JSON.parse(timed.out).checks[0].status).toBe("failed");
  } finally { e.cleanup(); }
}, 20000);

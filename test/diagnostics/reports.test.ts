import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { appendDiagnosticLog, buildDiagnosticBundle, diagnosticZip, recordCrash } from "../../src/diagnostics/reports.ts";
import { rendererCrashReceiver, saveBugReport } from "../../desktop/main/bug-report.ts";

test("local crash capture is bounded, redacts patterns, preserves unrelated files and exports only allowlisted evidence", async () => {
  const e = tmpEnv(); try {
    appendDiagnosticLog(e.rigwellHome, 'password="fixture-secret"'); const file = recordCrash(e.rigwellHome, "main", "fixture", new Error('Bearer fixture-private-value'))!;
    expect(existsSync(file)).toBe(true); expect(readFileSync(file, "utf8")).not.toContain("fixture-private-value"); expect(readFileSync(join(e.rigwellHome, "logs/main.log"), "utf8")).not.toContain("fixture-secret");
    const foreign = join(e.rigwellHome, "crashes/owner-note.txt"); writeFileSync(foreign, "keep");
    for (let i = 0; i < 55; i++) recordCrash(e.rigwellHome, "renderer", "fixture", "x".repeat(30000));
    expect(readdirSync(join(e.rigwellHome, "crashes")).filter((n) => n.endsWith(".json"))).toHaveLength(50); expect(readFileSync(foreign, "utf8")).toBe("keep");
    writeFileSync(join(e.rigwellHome, "credentials.json"), "never-export-credentials"); writeFileSync(join(e.rigwellHome, "logs/private.log"), "never-export-extra-log"); writeFileSync(join(e.rigwellHome, "logs/daemon-stderr.log"), "known-fake-credential and visible log");
    const b = buildDiagnosticBundle(e.rigwellHome, { rigwell: "fixture-version" }, ["known-fake-credential"]), text = b.bytes.toString("utf8"); expect(b.files).toContain("versions.json"); expect(b.files).toContain("logs/daemon-stderr.log"); expect(b.files).toContain("manifest.json"); expect(text).toContain("fixture-version"); expect(text).toContain("visible log"); expect(text).not.toContain("known-fake-credential"); expect(text).not.toContain("never-export-credentials"); expect(text).not.toContain("never-export-extra-log"); expect(b.files.filter((n) => n.startsWith("crashes/"))).toHaveLength(50);
    let builds = 0; const builder = () => { builds++; return b; }; expect(await saveBugReport(e.rigwellHome, {}, async () => null, builder)).toBeNull(); expect(builds).toBe(0);
    const out = join(e.root, "bug.zip"); expect((await saveBugReport(e.rigwellHome, {}, async () => out, builder))?.file).toBe(out); expect(readFileSync(out)).toEqual(b.bytes);
    expect(() => diagnosticZip([{ name: "../unsafe", text: "no" }])).toThrow();
    expect(() => diagnosticZip([{ name: "..", text: "no" }])).toThrow();
  } finally { e.cleanup(); }
});

test("actual fatal process capture records main and daemon failures without swallowing exit", () => {
  const e = tmpEnv(); try {
    const module = resolve(import.meta.dir, "../../src/diagnostics/reports.ts");
    for (const [source, fault] of [["main", 'setTimeout(()=>{throw new Error("synthetic-fatal")},0)'], ["daemon", 'Promise.reject(new Error("synthetic-rejection"))']] as const) {
      const code = `import {installProcessCrashCapture} from ${JSON.stringify(module)};installProcessCrashCapture(process.env.RIGWELL_HOME,${JSON.stringify(source)});${fault}`;
      const child = spawnSync(process.execPath, ["-e", code], { env: { ...process.env }, cwd: e.root, encoding: "utf8", timeout: 5000, windowsHide: true }); expect(child.status).not.toBe(0); expect(child.error).toBeUndefined();
    }
    const reports = readdirSync(join(e.rigwellHome, "crashes")).map((n) => JSON.parse(readFileSync(join(e.rigwellHome, "crashes", n), "utf8"))); expect(reports.some((r) => r.source === "main" && r.detail.includes("synthetic-fatal"))).toBe(true); expect(reports.some((r) => r.source === "daemon" && r.kind === "unhandledRejection" && r.detail.includes("synthetic-rejection"))).toBe(true);
    const parent = join(e.root, "not-a-directory"); writeFileSync(parent, "fixture"); const startup = spawnSync(process.execPath, [resolve(import.meta.dir, "../../src/cli/main.ts"), "daemon", "--socket", join(parent, "daemon.sock"), "--no-ws", "--no-automations", "--no-background-services", "--no-advertise"], { env: { ...process.env }, cwd: e.root, encoding: "utf8", timeout: 5000, windowsHide: true }); expect(startup.status).toBe(2); expect(startup.error).toBeUndefined(); expect(readdirSync(join(e.rigwellHome, "crashes")).some((n) => JSON.parse(readFileSync(join(e.rigwellHome, "crashes", n), "utf8")).kind === "startup")).toBe(true);
  } finally { e.cleanup(); }
});

test("renderer messages are bounded and rate limited; linked inputs and export targets are refused", async () => {
  const e = tmpEnv(); try {
    const receive = rendererCrashReceiver(e.rigwellHome); expect(receive(1, { kind: "fixture", detail: "renderer detail" })).toBe(true);
    for (const p of [null, { kind: "x", detail: "x", path: "unsafe" }, { kind: "x", detail: "x".repeat(24001) }]) expect(() => receive(1, p)).toThrow();
    for (let i = 0; i < 9; i++) expect(receive(1, { kind: "fixture", detail: "renderer detail" })).toBe(true); expect(receive(1, { kind: "fixture", detail: "renderer detail" })).toBe(false);
    const target = join(e.root, "outside.txt"); writeFileSync(target, "untouched"); mkdirSync(join(e.rigwellHome, "logs")); symlinkSync(target, join(e.rigwellHome, "logs/main.log")); appendDiagnosticLog(e.rigwellHome, "must not follow"); expect(readFileSync(target, "utf8")).toBe("untouched");
    const bundle = buildDiagnosticBundle(e.rigwellHome, {}, []); expect(bundle.files).not.toContain("logs/main.log"); expect(bundle.omitted.some((s) => s.includes("main.log"))).toBe(true);
    writeFileSync(join(e.rigwellHome, "logs/daemon-stderr.log"), "x".repeat(256 * 1024 + 1)); expect(buildDiagnosticBundle(e.rigwellHome, {}, []).omitted.some((s) => s.includes("exceeds"))).toBe(true);
    writeFileSync(join(e.rigwellHome, "logs/daemon-stderr.log"), "x".repeat(300000) + "\nrecent log after oversized history\npassword=private-tail-fixture\n"); const tail = buildDiagnosticBundle(e.rigwellHome, {}, []); expect(tail.files).toContain("logs/daemon-stderr.log"); expect(tail.bytes.toString()).toContain("recent log after oversized history"); expect(tail.bytes.toString()).not.toContain("private-tail-fixture"); expect(tail.omitted.some((s) => s.includes("earlier bytes omitted"))).toBe(true);
    const out = join(e.root, "linked.zip"); symlinkSync(target, out); const error = await saveBugReport(e.rigwellHome, {}, async () => out, () => bundle).then(() => null, (e) => e); expect(error.message).toContain("linked"); expect(readFileSync(target, "utf8")).toBe("untouched");
  } finally { e.cleanup(); }
});

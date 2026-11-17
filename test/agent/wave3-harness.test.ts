// Wave 3 harness items: secret scan, spec handoff, small fields, cacheKey, compactionModelMode, org ceiling.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHandoff } from "../../src/agent/handoff.ts";
import { commitIntent, scanDiff, scanLine } from "../../src/permissions/secretscan.ts";
import { call, makeStubSession, text } from "./helpers.ts";

let home = "";
const prevHome = process.env.RIGWELL_HOME;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "rigwell-w3-home-")); process.env.RIGWELL_HOME = home; });
afterEach(() => { if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome; });

const AWS = "AKIA" + "QWERTYUIOPASDFGH"; // 20 chars, assembled so this file holds no key-shaped literal
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

function repoWithStagedSecret(cwd: string, content = `const k = "${AWS}";\n`) {
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd });
  writeFileSync(path.join(cwd, "cfg.ts"), content);
  execSync("git add cfg.ts", { cwd });
}
const commitCall = () => call("Execute", { command: "git commit -q -m add", riskLevel: "low", riskReason: "commit" });
const commits = (cwd: string) => { try { return execSync("git rev-list --count HEAD", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "0"; } };

test("secret scan rules: shapes hit, placeholders and non-added lines do not", () => {
  expect(scanLine(`key = "${AWS}"`).map((f) => f.rule.id)).toEqual(["aws-access-key-id"]);
  expect(scanLine(GH).map((f) => f.rule.id)).toEqual(["github-token"]);
  expect(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----").map((f) => f.rule.id)).toEqual(["private-key"]);
  expect(scanLine("token = 'your-token-goes-here-123456'")).toEqual([]);
  expect(scanLine("AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  const diff = `+++ b/a.ts\n@@ -1,1 +4,2 @@\n context\n+const t = "${GH}";\n-old = "${AWS}"\n`;
  const f = scanDiff(diff);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ rule: "github-token", file: "a.ts", line: 5 });
  expect(f[0]!.preview.length).toBeLessThan(8); // never the whole secret
});

test("commitIntent finds git commit through chains, options and -a", () => {
  expect(commitIntent("git commit -m x")).toMatchObject({ commit: true, all: false, stages: false });
  expect(commitIntent("git add . && git commit -am 'x'")).toMatchObject({ commit: true, all: true, stages: true });
  expect(commitIntent("git -C sub -c user.name=x commit --all -m y").commit).toBe(true);
  expect(commitIntent("echo git commit").commit).toBe(false);
  expect(commitIntent("git log").commit).toBe(false);
});

test("secret scan: off by default, a commit with a secret just runs", async () => {
  const { session, cwd } = makeStubSession((_r, n) => (n === 0 ? commitCall() : text("ok")));
  repoWithStagedSecret(cwd);
  session.addUserMessage("commit");
  await session.idle();
  expect(commits(cwd)).toBe("1");
});

test("secret scan: cancel blocks the commit and proceed_once runs it", async () => {
  const answers = ["cancel", "proceed_once"];
  const asked: any[] = [];
  const { session, cwd, requests } = makeStubSession(
    (_r, n) => (n % 2 === 0 ? commitCall() : text("ok")),
    { enableSecretScan: true, autoRejectPermissionRequests: false },
  );
  (session as any).host.requestPermission = async (p: any) => { asked.push(p); return { selectedOption: answers[asked.length - 1] }; };
  repoWithStagedSecret(cwd);

  session.addUserMessage("commit 1");
  await session.idle();
  expect(asked).toHaveLength(1);
  expect(asked[0].toolUses[0].confirmationType).toBe("secret_scan_violation");
  expect(asked[0].options.map((o: any) => o.value)).toEqual(["proceed_once", "proceed_report_false_positive", "cancel"]);
  expect(asked[0].options.map((o: any) => o.label)).toEqual(["Proceed anyway", "Proceed & report false positive", "Cancel"]);
  expect(asked[0].toolUses[0].details.findings[0]).toMatchObject({ rule: "aws-access-key-id", file: "cfg.ts", line: 1 });
  expect(JSON.stringify(asked[0])).not.toContain(AWS);
  expect(commits(cwd)).toBe("0");
  expect(JSON.stringify(requests.at(-1)!.messages)).toContain("cancelled this commit");

  session.addUserMessage("commit 2");
  await session.idle();
  expect(asked).toHaveLength(2);
  expect(commits(cwd)).toBe("1");
});

test("secret scan: a reported false positive is logged and not asked again on the next commit", async () => {
  const asked: any[] = [];
  const { session, cwd } = makeStubSession(
    (_r, n) => (n % 2 === 0 ? commitCall() : text("ok")),
    { enableSecretScan: true, autoRejectPermissionRequests: false },
  );
  (session as any).host.requestPermission = async (p: any) => { asked.push(p); return { selectedOption: "proceed_report_false_positive" }; };
  repoWithStagedSecret(cwd);
  session.addUserMessage("commit and report the false positive");
  await session.idle();
  expect(asked).toHaveLength(1);
  expect(commits(cwd)).toBe("1");
  const log = readFileSync(path.join(home, "logs", "secret-scan-false-positives.jsonl"), "utf8");
  expect(log).toContain("aws-access-key-id");
  expect(log).not.toContain(AWS);

  writeFileSync(path.join(cwd, "other.ts"), `x("${AWS}")\n`);
  execSync("git add other.ts", { cwd });
  session.addUserMessage("commit the same finding again");
  await session.idle();
  expect(asked).toHaveLength(1);
  expect(commits(cwd)).toBe("2");
});

test("secret scan: with nobody to ask the commit is not run", async () => {
  const { session, cwd, requests } = makeStubSession((_r, n) => (n === 0 ? commitCall() : text("ok")), { enableSecretScan: true });
  repoWithStagedSecret(cwd);
  session.addUserMessage("commit");
  await session.idle();
  expect(commits(cwd)).toBe("0");
  expect(JSON.stringify(requests.at(-1)!.messages)).toContain("nobody can confirm");
});

test("secret scan: a clean commit is not interrupted", async () => {
  const asked: any[] = [];
  const { session, cwd } = makeStubSession((_r, n) => (n === 0 ? commitCall() : text("ok")), { enableSecretScan: true, autoRejectPermissionRequests: false });
  (session as any).host.requestPermission = async (p: any) => { asked.push(p); return { selectedOption: "cancel" }; };
  repoWithStagedSecret(cwd, "const a = 1;\n");
  session.addUserMessage("commit");
  await session.idle();
  expect(asked).toHaveLength(0);
  expect(commits(cwd)).toBe("1");
});

// ---------- spec handoff ----------

function specSession(option: string, over: Record<string, unknown> = {}) {
  const asked: any[] = [];
  const made = makeStubSession((_r, n) => (n === 0 ? call("ExitSpecMode", { title: "Fix greet", plan: "# Plan\n1. fix it" }) : text("never")), {
    settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "spec", autonomyLevel: "off" }, autoRejectPermissionRequests: false, ...over,
  });
  (made.session as any).host.requestPermission = async (p: any) => { asked.push(p); return { selectedOption: option, clientStartsHandoffSession: true }; };
  return { ...made, asked };
}

test("spec handoff: proceed_new_session_medium ends the turn with spec_handoff and records the brief", async () => {
  const { session, notes, asked, requests } = specSession("proceed_new_session_medium");
  session.addUserMessage("plan it");
  await session.idle();
  const d = asked[0].toolUses[0].details;
  expect(d.supportsClientStartedHandoff).toBe(true);
  expect(typeof d.contextSavingsPercent).toBe("number");
  expect(asked[0].options.map((o: any) => o.value)).toContain("proceed_new_session_high");
  expect(requests).toHaveLength(1); // the turn ended: no second model call
  expect(notes.find((n) => n.type === "agent_turn_completed").reason).toBe("spec_handoff");
  const h = notes.find((n) => n.type === "spec_handoff");
  expect(h).toMatchObject({ autonomyLevel: "medium", title: "Fix greet", clientStartsHandoffSession: true });
  expect(typeof h.contextSavingsPercent).toBe("number");
  const rec = loadHandoff(h.specHandoffId)!;
  expect(rec.plan).toContain("1. fix it");
  expect(rec.autonomyLevel).toBe("medium");
  expect(existsSync(rec.specPath!)).toBe(true);
  expect(session.settings.interactionMode).toBe("auto");
});

test("spec handoff: plain proceed_new_session starts at autonomy off; not offered headless", async () => {
  const { session, notes } = specSession("proceed_new_session");
  session.addUserMessage("plan it");
  await session.idle();
  expect(notes.find((n) => n.type === "spec_handoff").autonomyLevel).toBe("off");
  const headless = makeStubSession(() => text("x"), { settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "spec", autonomyLevel: "off" } });
  expect(headless.session.settings.interactionMode).toBe("spec");
});

test("org ceiling: handoff and auto-run options above maxAutonomy are not offered, settings are clamped", async () => {
  const { session, asked } = specSession("proceed_once", { maxAutonomy: "low" });
  session.addUserMessage("plan it");
  await session.idle();
  const values = asked[0].options.map((o: any) => o.value);
  expect(values).toContain("proceed_auto_run_low");
  expect(values).not.toContain("proceed_auto_run_medium");
  expect(values).not.toContain("proceed_new_session_high");
  session.updateSettings({ autonomyLevel: "high" });
  expect(session.settings.autonomyLevel).toBe("low");
});

// ---------- small fields ----------

test("openaiPhase from the adapter is stored on the assistant message", async () => {
  const stored: any[] = [];
  const { session } = makeStubSession(() => text("hi"), { persistence: { appendMessage: async (m: any) => { stored.push(m); }, appendTurnOutcome: async () => {}, saveSettings: async () => {} } });
  (session as any).deps.streamWithRetry = async function* () {
    yield { type: "message_done", content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 }, openaiPhase: "final_answer" };
  };
  session.addUserMessage("go");
  await session.idle();
  expect(stored.find((m) => m.role === "assistant").openaiPhase).toBe("final_answer");
});

test("cacheKey: a session with a cacheKey puts it on every request; default is absent", async () => {
  const a = makeStubSession(() => text("x"), { cacheKey: "parent-session" });
  a.session.addUserMessage("go");
  await a.session.idle();
  expect(a.requests[0]!.cacheKey).toBe("parent-session");
  expect(a.requests[0]!.sessionId).toBe(a.session.id);
  const b = makeStubSession(() => text("x"));
  b.session.addUserMessage("go");
  await b.session.idle();
  expect(b.requests[0]!.cacheKey).toBeUndefined();
  expect(b.session.cacheKey).toBe(b.session.id);
});

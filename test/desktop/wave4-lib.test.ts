// Wave 4 pure logic: audio encoding, spec handoff, secrets/environments/OAuth helpers, automation templates, org labels,
// the new desktop settings and the broker's active-session count (tray).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonBroker } from "../../desktop/main/broker.ts";
import { readOrgManaged } from "../../desktop/main/org-managed.ts";
import { loadDesktopSettings, updateDesktopSettings } from "../../desktop/main/settings.ts";
import { DEFAULT_ENV_ROW, defaultMode, deleteWarning, filterDomains, importSummary, mcpAuthButtons, pollLogin, providerStatus, validateSecret, varsToParam, type LoginStatus } from "../../desktop/renderer/lib/access.ts";
import { isHandoffOption, nextHandoff, specAnswer, specOptions } from "../../desktop/renderer/lib/handoff.ts";
import { groupTemplates, previewInstructions, setupCard, templateCreate, visualStale, type TemplateRow } from "../../desktop/renderer/lib/templates.ts";
import { downmix, encodeWav, resample, toSpeechWav } from "../../desktop/renderer/lib/wav.ts";

describe("wav", () => {
  test("encodeWav writes a 16-bit mono PCM header and clamps samples", () => {
    const w = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16000);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.slice(8, 12))).toBe("WAVE");
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(10); // data bytes
    expect([2, 3, 4, 5, 6].map((i) => v.getInt16(44 + (i - 2) * 2, true))).toEqual([0, 32767, -32768, 32767, -32768]);
  });
  test("resample changes the length by the rate ratio; downmix averages channels", () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
    expect(resample(new Float32Array([1, 2]), 16000, 16000).length).toBe(2);
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    expect(toSpeechWav([new Float32Array(44100)], 44100).length).toBe(44 + 16000 * 2);
  });
});

describe("spec handoff", () => {
  const opts = [{ label: "Approve", value: "proceed_once" }, { label: "Hand off to a new session at low", value: "proceed_new_session_low" }, { label: "Hand off to a new session", value: "proceed_new_session" }];
  test("handoff options carry the context savings and the client-starts flag", () => {
    const shown = specOptions(opts, 62.4);
    expect(shown[0].label).toBe("Approve");
    expect(shown[1].label).toBe("Hand off to a new session at low (62% context saved)");
    expect(specOptions(opts, undefined)[2].label).toBe("Hand off to a new session");
    expect(specAnswer("proceed_new_session_low")).toEqual({ selectedOption: "proceed_new_session_low", clientStartsHandoffSession: true });
    expect(specAnswer("proceed_once", { comment: " go " })).toEqual({ selectedOption: "proceed_once", comment: "go" });
    expect(specAnswer("proceed_edit", { editedSpec: "# x" })).toEqual({ selectedOption: "proceed_edit", editedSpecContent: "# x" });
    expect(isHandoffOption("proceed_once")).toBe(false);
  });
  test("the new session starts once, after both the notification and the turn end, in either order", () => {
    let r = nextHandoff({}, { type: "spec_handoff", specHandoffId: "h1" });
    expect(r.start).toBeUndefined();
    r = nextHandoff(r.state, { type: "agent_turn_completed", reason: "completed" });
    expect(r.start).toBeUndefined();
    r = nextHandoff(r.state, { type: "agent_turn_completed", reason: "spec_handoff" });
    expect(r.start).toBe("h1");
    expect(nextHandoff(r.state, { type: "agent_turn_completed", reason: "spec_handoff" }).start).toBeUndefined();
    const early = nextHandoff({}, { type: "agent_turn_completed", reason: "spec_handoff" });
    expect(nextHandoff(early.state, { type: "spec_handoff", specHandoffId: "h2" }).start).toBe("h2");
  });
});

describe("secrets, environments and sign-in", () => {
  test("secret validation", () => {
    expect(validateSecret("OPENAI_KEY", "v", [], false)).toBeNull();
    expect(validateSecret("bad name", "v", [], false)).toMatch(/Names use/);
    expect(validateSecret("A", "v", ["A"], false)).toMatch(/already exists/);
    expect(validateSecret("A", "v", ["A"], true)).toBeNull();
    expect(validateSecret("A", "", [], false)).toMatch(/value/);
    expect(deleteWarning({ name: "A", usedBy: ["prod"] })).toContain("prod");
  });
  test("environment rows become the vars parameter; bad rows are explained", () => {
    expect(varsToParam([{ name: "A", kind: "literal", value: "1" }, { name: "B", kind: "secret", secret: "S" }])).toEqual({ A: "1", B: { secret: "S" } });
    expect(() => varsToParam([{ name: "1A", kind: "literal", value: "" }])).toThrow(/not a valid variable name/);
    expect(() => varsToParam([{ name: "A", kind: "literal", value: "" }, { name: "A", kind: "literal", value: "" }])).toThrow(/twice/);
    expect(() => varsToParam([{ name: "A", kind: "secret", secret: "" }])).toThrow(/Choose a secret/);
    expect(DEFAULT_ENV_ROW.kind).toBe("literal");
  });
  test("provider status and sign-in mode", () => {
    const p = { name: "a", loggedIn: false, scopes: [], browserLogin: true, deviceLogin: true };
    expect(providerStatus(p)).toBe("Signed out");
    expect(providerStatus({ ...p, loggedIn: true, expired: true, hasRefreshToken: false })).toBe("Signed in, expired");
    expect(providerStatus({ ...p, loggedIn: true })).toBe("Signed in");
    expect(defaultMode(p)).toBe("browser");
    expect(defaultMode({ browserLogin: false, deviceLogin: true })).toBe("device");
  });
  test("pollLogin waits while pending and stops on complete, failure, cancel and timeout", async () => {
    const base: LoginStatus = { loginId: "1", name: "a", kind: "device", state: "pending" };
    let n = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    const done = await pollLogin(async () => ({ ...base, state: ++n < 3 ? "pending" : "complete" }), { sleep, intervalMs: 5 });
    expect(done.state).toBe("complete");
    expect(slept).toEqual([5, 5]);
    expect((await pollLogin(async () => ({ ...base, state: "failed", error: "denied" }), { sleep })).error).toBe("denied");
    expect((await pollLogin(async () => base, { sleep, cancelled: () => true })).state).toBe("cancelled");
    expect((await pollLogin(async () => base, { sleep, intervalMs: 10, maxMs: 30 })).error).toMatch(/Timed out/);
  });
  test("mcpAuthButtons: Sign in when the server needs sign-in, Sign out when a token is stored", () => {
    expect(mcpAuthButtons({})).toEqual({ signIn: false, signOut: false }); // stdio, or OAuth off
    expect(mcpAuthButtons({ requiresAuth: true, hasAuthTokens: false })).toEqual({ signIn: true, signOut: false });
    expect(mcpAuthButtons({ requiresAuth: false, hasAuthTokens: true })).toEqual({ signIn: false, signOut: true });
    expect(mcpAuthButtons({ requiresAuth: true, hasAuthTokens: true })).toEqual({ signIn: true, signOut: true }); // the sign-in expired
  });
  test("cookie site filter and summary", () => {
    const l = [{ domain: "a.example.com", count: 1 }, { domain: "b.org", count: 2 }];
    expect(filterDomains(l, "EXAMPLE")).toEqual([l[0]]);
    expect(filterDomains(l, " ")).toEqual(l);
    expect(importSummary({ imported: 1, skipped: 0 })).toBe("Imported 1 cookie.");
    expect(importSummary({ imported: 3, skipped: 2 })).toContain("2 could not be");
  });
});

describe("automation templates", () => {
  const t: TemplateRow = { id: "x", name: "X", description: "d", category: "health", schedule: "daily", parameters: [{ key: "cmd", label: "Command" }, { key: "n", label: "Count", default: "5" }], instructions: "Run {{cmd}} {{n}} times, then {{other}}" };
  test("grouping, required parameters and the create params", () => {
    expect(groupTemplates([t, { ...t, id: "y", category: "git" }, { ...t, id: "z" }]).map((g) => [g.category, g.templates.length])).toEqual([["health", 2], ["git", 1]]);
    expect(templateCreate(t, { cmd: "", n: "" }, {})).toEqual({ error: "Fill in: Command." });
    expect(templateCreate(t, { cmd: "bun test", n: "" }, { workingDirectory: " /r " })).toEqual({ params: { templateId: "x", parameters: { cmd: "bun test", n: "5" }, workingDirectory: "/r" } });
    expect(previewInstructions(t, { cmd: "bun test", n: "5" })).toBe("Run bun test 5 times, then {{other}}");
  });
  test("visual refresh while a run is in progress; the review card for CreateAutomation", () => {
    expect(visualStale([{ status: "in_progress" }])).toBe(true);
    expect(visualStale([{ status: "succeeded" }])).toBe(false);
    const card = setupCard({ confirmationType: "exec", toolUse: { name: "CreateAutomation" }, details: { toolName: "CreateAutomation", input: { name: "Nightly", schedule: "daily", instructions: "do it" } } });
    expect(card?.lines).toEqual(["Name: Nightly", "Schedule: daily", "Instructions: do it"]);
    expect(setupCard({ toolUse: { name: "Execute" }, details: {} })).toBeNull();
  });
});

describe("org labels, settings and the tray counts", () => {
  test("the org file's keys are read; a missing or broken file means not managed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-org-"));
    try {
      const f = join(dir, "org.json");
      writeFileSync(f, JSON.stringify({ managedSettings: { maxAutonomyLevel: "low", customModels: [] } }));
      expect(readOrgManaged({ RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH: f })).toEqual({ managed: true, keys: ["maxAutonomyLevel", "customModels"], maxAutonomyLevel: "low" });
      writeFileSync(f, "{ nope");
      expect(readOrgManaged({ RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH: f }).managed).toBe(false);
      expect(readOrgManaged({}).managed).toBe(false);
      expect(readOrgManaged({ RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH: join(dir, "missing.json") }).managed).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("new desktop settings default sensibly and are sanitized", () => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-ds-"));
    try {
      const d = loadDesktopSettings(dir);
      expect(d).toMatchObject({ menuBarEnabled: true, updatePublicKey: "", dictation: { backend: "off", command: "" } });
      const next = updateDesktopSettings(dir, { dictation: { backend: "bogus", command: 5 }, updatePublicKey: "abc" });
      expect(next.dictation.backend).toBe("off");
      expect(next.dictation.command).toBe("");
      expect(next.updatePublicKey).toBe("abc");
      expect(updateDesktopSettings(dir, { dictation: { backend: "command", command: "x {file}" } }).dictation).toMatchObject({ backend: "command", command: "x {file}" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("the broker counts working sessions and open requests", () => {
    class FakeWS {
      static last: FakeWS;
      readyState = 1;
      private l = new Map<string, ((e: any) => void)[]>();
      constructor(public url: string) { FakeWS.last = this; queueMicrotask(() => this.emit("open", {})); }
      addEventListener(n: string, f: (e: any) => void) { this.l.set(n, [...(this.l.get(n) ?? []), f]); }
      emit(n: string, e: any) { for (const f of this.l.get(n) ?? []) f(e); }
      send() {}
      close() { this.emit("close", {}); }
    }
    const seen: number[] = [];
    const b = new DaemonBroker(() => ({ wsUrl: "ws://127.0.0.1:1", token: "t" }), { deliver() {}, onAttention() {}, onActivity: (n) => seen.push(n) }, FakeWS as any);
    return b.openConnection(1).then(() => {
      const note = (type: string, extra: Record<string, unknown>) => FakeWS.last.emit("message", { data: JSON.stringify({ type: "notification", method: "rigwell.session_notification", params: { sessionId: "s1", notification: { type, ...extra } } }) });
      note("agent_working_state_changed", { newState: "streaming_assistant_message" });
      expect(b.activeCount).toBe(1);
      note("agent_working_state_changed", { newState: "streaming_assistant_message" });
      note("agent_working_state_changed", { newState: "idle" });
      expect(b.activeCount).toBe(0);
      note("agent_working_state_changed", { newState: "executing_tool" });
      FakeWS.last.close();
      expect(b.activeCount).toBe(0);
      expect(seen).toEqual([1, 0, 1, 0]);
    });
  });
});

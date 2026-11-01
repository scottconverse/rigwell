// Desktop pages logic (no Electron): Mission Control, Automations, settings pages, session menu, model picker, tabs.
// Renderer view-model functions are pure; the app model is driven through a fake preload bridge standing in for the broker.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCreate, duration, showQuitWarning, statusLabel, tabMatches, when, type AutomationRow } from "../../desktop/renderer/lib/automations.ts";
import { emptyForm, toEntry, toForm, validate } from "../../desktop/renderer/lib/custom-models.ts";
import { AUTO, normalizeModel, pickerSections } from "../../desktop/renderer/lib/models.ts";
import { applyNote, counts, fromGet, inTab, pauseBanner, percentDone, tabOf, workerRows, type MissionFeature } from "../../desktop/renderer/lib/missions.ts";
import { actionCall, bulkRename, groupByProject, managementRows, normalizeSession, sidebarRows } from "../../desktop/renderer/lib/sessions.ts";
import { moveTab, pushClosed, stepTab } from "../../desktop/renderer/lib/tabs.ts";
import { addUsage, fmt, percentUsed, total, zero } from "../../desktop/renderer/lib/usage.ts";
import { deleteLocalProfile, listProfileViews, parseProfileText, readUserSettings, saveLocalProfile, trustFolder, updateUserSettings } from "../../desktop/main/user-settings.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rigwell-pages-"));
const feat = (id: string, status: MissionFeature["status"], extra: Partial<MissionFeature> = {}): MissionFeature => ({ id, description: `Feature ${id}`, skillName: "w", milestone: "m1", status, ...extra });

describe("Mission Control view model (spec 15.8)", () => {
  test("tabs: running, paused (including awaiting input) and completed", () => {
    expect(tabOf("running")).toBe("Running");
    expect(tabOf("orchestrator_turn")).toBe("Running");
    expect(tabOf("paused")).toBe("Paused");
    expect(tabOf("awaiting_input")).toBe("Paused");
    expect(tabOf("completed")).toBe("Completed");
    expect(inTab("planning", "All")).toBe(true);
    expect(inTab("running", "Paused")).toBe(false);
  });

  test("a running mission from mission_get: counts, progress and the active worker", () => {
    const d = fromGet({
      exists: true, state: "running", updatedAt: "t", features: [feat("a", "completed", { workerSessionIds: ["w1"] }), feat("b", "in_progress", { workerSessionIds: ["w2"], currentWorkerSessionId: "w2" }), feat("c", "pending"), feat("d", "cancelled")],
      progress: { activeTime: { elapsedMs: 5000, measuredAtMs: 1 } }, progressLog: [], tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(d.state).toBe("running");
    expect(counts(d.features)).toMatchObject({ total: 4, completed: 1, in_progress: 1, pending: 1, cancelled: 1 });
    expect(percentDone(d.features)).toBe(33);
    const rows = workerRows(d.features);
    expect(rows.map((r) => [r.workerSessionId, r.active])).toEqual([["w1", false], ["w2", true]]);
  });

  test("notifications update the detail: state, features, log and worker exit", () => {
    const exits: Record<string, number> = {};
    let d = fromGet({ exists: true, state: "running", features: [feat("b", "in_progress", { workerSessionIds: ["w2"], currentWorkerSessionId: "w2" })], progressLog: [] });
    d = applyNote(d, { type: "mission_progress_entry", progressLog: { type: "worker_started" } }, exits);
    expect(d.progressLog).toHaveLength(1);
    d = applyNote(d, { type: "mission_worker_completed", workerSessionId: "w2", exitCode: 0 }, exits);
    expect(workerRows(d.features, exits)[0].active).toBe(false);
    d = applyNote(d, { type: "mission_features_changed", features: [feat("b", "completed")] }, exits);
    expect(d.features[0].status).toBe("completed");
    d = applyNote(d, { type: "mission_state_changed", state: "completed" }, exits);
    expect(d.state).toBe("completed");
    expect(applyNote(d, { type: "unrelated" }, exits)).toBe(d);
  });

  test("pause reasons have readable text", () => {
    expect(pauseBanner("crash_recovery")).toContain("restarted");
    expect(pauseBanner("something_new")).toBe("Paused: something new.");
    expect(pauseBanner(undefined)).toBeUndefined();
  });
});

describe("Automations view model (spec 16.7)", () => {
  const row = (p: Partial<AutomationRow>): AutomationRow => ({ id: "a", name: "A", isValid: true, trigger: "schedule", paused: false, status: "active", runCount: 0, ...p });

  test("create form: presets, custom schedule, validation messages", () => {
    const base = { name: "Nightly", preset: "daily", custom: "", instructions: "Run the tests", workingDirectory: "", trigger: "schedule" as const };
    expect(buildCreate(base)).toEqual({ params: { name: "Nightly", instructions: "Run the tests", trigger: "schedule", schedule: "daily" } });
    expect(buildCreate({ ...base, preset: "custom", custom: "every 30m" })).toMatchObject({ params: { schedule: "every 30m" } });
    expect(buildCreate({ ...base, preset: "custom" })).toHaveProperty("error");
    expect(buildCreate({ ...base, name: " " })).toHaveProperty("error");
    expect(buildCreate({ ...base, instructions: "" })).toHaveProperty("error");
    expect(buildCreate({ ...base, trigger: "webhook" })).toEqual({ params: { name: "Nightly", instructions: "Run the tests", trigger: "webhook" } });
  });

  test("labels, tabs, durations and times", () => {
    expect(statusLabel(row({ status: "degraded" }))).toBe("Needs attention");
    expect(statusLabel(row({ isValid: false, invalidReason: "bad schedule" }))).toBe("Invalid: bad schedule");
    expect(tabMatches(row({ paused: true }), "Paused")).toBe(true);
    expect(tabMatches(row({ paused: true }), "Active")).toBe(false);
    expect(duration({ startedAt: 0, finishedAt: 75_000 })).toBe("1m 15s");
    expect(duration({ startedAt: 0 })).toBe("running");
    expect(when(undefined)).toBe("never");
    expect(when(60 * 60_000 + 1000, 0)).toBe("in 1 h");
  });

  test("the quit warning shows only while something is active and until it is dismissed", () => {
    expect(showQuitWarning([row({})], false)).toBe(true);
    expect(showQuitWarning([row({})], true)).toBe(false);
    expect(showQuitWarning([row({ paused: true })], false)).toBe(false);
    expect(showQuitWarning([], false)).toBe(false);
  });
});

describe("sessions list and header menu (spec 14.3)", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  const mk = (id: string, extra: Record<string, unknown> = {}) => normalizeSession({ sessionId: id, title: id, cwd: "/p", updatedAt: now - 1000, ...extra });
  const list = [mk("old", { updatedAt: now - 5000 }), mk("new"), mk("pin", { pinned: true, updatedAt: now - 9000 }), mk("arch", { archivedAt: now }), mk("sub", { isSubagent: true }), mk("empty", { hasUserVisibleMessages: false })];

  test("sidebar: pinned first, archived, subagent and empty hidden", () => {
    expect(sidebarRows(list, { now }).map((s) => s.id)).toEqual(["pin", "new", "old"]);
    expect(groupByProject(sidebarRows(list, { now }))[0][0]).toBe("/p");
  });

  test("older daemon rows (daemon.list_sessions) still work", () => {
    expect(normalizeSession({ id: "x", title: "t", cwd: "/c", updatedAt: 5 })).toMatchObject({ id: "x", pinned: false, archivedAt: null });
  });

  test("session management: tabs, search and bulk rename", () => {
    expect(managementRows(list, "archived", { now }).map((s) => s.id)).toEqual(["arch"]);
    expect(managementRows(list, "active", { query: "ol", now }).map((s) => s.id)).toEqual(["old"]);
    const plan = bulkRename([mk("fix a"), mk("fix b"), mk("other")], "fix", "repair");
    expect(plan.map((p) => p.title)).toEqual(["repair a", "repair b"]);
    expect(bulkRename([mk("x")], "", "y")).toEqual([]);
  });

  test("header actions map to the contract methods", () => {
    expect(actionCall("pin", { pinned: false, archivedAt: null })).toEqual({ method: "pin_session", params: { pinned: true } });
    expect(actionCall("pin", { pinned: true, archivedAt: null }).params).toEqual({ pinned: false });
    expect(actionCall("archive", { pinned: false, archivedAt: null })).toEqual({ method: "archive_session", params: { archived: true } });
    expect(actionCall("archive", { pinned: false, archivedAt: 5 }).params).toEqual({ archived: false });
    expect(actionCall("rename", {}, "  New name ")).toEqual({ method: "rename_session", params: { title: "New name" } });
    expect(() => actionCall("rename", {}, "  ")).toThrow();
  });
});

describe("model picker (spec 14.3)", () => {
  const models = ["anthropic", "openai", "anthropic"].map((p, i) => normalizeModel({ id: `m${i}`, displayName: `Model ${i}`, modelProvider: p }));
  test("auto first, pinned next, then providers", () => {
    const s = pickerSections(models, { autoAvailable: true, pinned: ["m1"] });
    expect(s.map((x) => x.title)).toEqual(["", "Pinned", "Anthropic"]);
    expect(s[0].models[0].id).toBe(AUTO);
    expect(s[2].models.map((m) => m.id)).toEqual(["m0", "m2"]);
  });
  test("search filters and no auto without a router", () => {
    expect(pickerSections(models, { query: "openai" }).flatMap((x) => x.models.map((m) => m.id))).toEqual(["m1"]);
    expect(pickerSections(models, {}).some((x) => x.models.some((m) => m.id === AUTO))).toBe(false);
    expect(pickerSections([], { query: "x" })).toEqual([]);
  });
});

describe("custom models form and secrets (spec 12.2)", () => {
  test("validation and entry", () => {
    const f = { ...emptyForm(), model: "claude-x", apiKey: "sk-secret-1234" };
    expect(validate(f)).toBeNull();
    expect(validate({ ...f, baseUrl: "ftp://x" })).toContain("base URL");
    expect(validate({ ...f, maxContextLimit: "-3" })).toContain("whole number");
    expect(toEntry({ ...f, headers: [{ key: "X-A", value: "v" }, { key: " ", value: "" }] })).toMatchObject({ model: "claude-x", provider: "anthropic", extraHeaders: { "X-A": "v" } });
    expect(toForm({ model: "m", extraHeaders: { a: "b" } }).headers).toEqual([{ key: "a", value: "b" }]);
  });

  test("the settings file never leaves the main process unmasked, and a masked key comes back as the real one", () => {
    const home = tmp();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ customModels: [{ model: "m", provider: "openai", baseUrl: "http://x", apiKey: "sk-real-secret-9999", extraHeaders: { Auth: "tok-1234567" } }, { model: "e", provider: "openai", baseUrl: "http://y", apiKey: "${MY_KEY}" }], other: 1 }));
    const shown = readUserSettings(home);
    expect(JSON.stringify(shown)).not.toContain("real-secret");
    expect(JSON.stringify(shown)).not.toContain("tok-1234567");
    expect(shown.customModels[0].apiKey).toBe("****9999");
    expect(shown.customModels[1].apiKey).toBe("${MY_KEY}");
    // The page saves the list back with an edited display name; the masked values mean "unchanged".
    shown.customModels[0].displayName = "Renamed";
    updateUserSettings(home, { customModels: shown.customModels });
    const disk = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(disk.customModels[0]).toMatchObject({ displayName: "Renamed", apiKey: "sk-real-secret-9999", extraHeaders: { Auth: "tok-1234567" } });
    expect(disk.other).toBe(1);
    // A new key replaces it; null removes a setting.
    updateUserSettings(home, { customModels: [{ ...shown.customModels[0], apiKey: "sk-new-0000" }], other: null });
    const disk2 = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(disk2.customModels[0].apiKey).toBe("sk-new-0000");
    expect("other" in disk2).toBe(false);
  });

  test("trusting a folder is recorded in trustedFolders", () => {
    const home = tmp(), folder = tmp();
    expect(trustFolder(home, folder).trustedFolders[folder]).toHaveProperty("trustedAt");
    expect(() => trustFolder(home, join(folder, "missing"))).toThrow();
  });
});

describe("worktree setup profiles (spec 18.3)", () => {
  test("local profiles round trip; repository YAML is read; deletes work", () => {
    const home = tmp(), repo = tmp();
    const id = saveLocalProfile(home, repo, { name: "Install deps", script: "npm ci\n", initialPrompt: "Check the build" });
    expect(listProfileViews(home, repo)).toMatchObject([{ id, source: "local", name: "Install deps", script: "npm ci\n" }]);
    mkdirSync(join(repo, ".rigwell/worktree-setups"), { recursive: true });
    writeFileSync(join(repo, ".rigwell/worktree-setups/team.yaml"), "name: Team setup\nscript: |\n  make deps\n  make build\n");
    const all = listProfileViews(home, repo);
    expect(all.map((p) => p.source)).toEqual(["repository", "local"]);
    expect(all[0].script).toBe("make deps\nmake build\n");
    deleteLocalProfile(home, repo, id);
    expect(listProfileViews(home, repo)).toHaveLength(1);
    expect(() => saveLocalProfile(home, repo, { name: "", script: "x" })).toThrow();
    expect(() => saveLocalProfile(home, repo, { name: "empty" })).toThrow();
    expect(parseProfileText("name: 'It''s'\n")).toEqual({ name: "It's" });
  });
});

describe("usage and browser tabs", () => {
  test("token totals", () => {
    const u = addUsage(addUsage(zero(), { inputTokens: 1500, outputTokens: 500 }), { inputTokens: 500, cacheReadTokens: 2000 });
    expect(total(u)).toBe(4500);
    expect(fmt(1_500_000)).toBe("1.5M");
    expect(percentUsed(50, 200)).toBe(25);
    expect(percentUsed(5, 0)).toBe(0);
  });
  test("move, step and reopen stack", () => {
    const t = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(moveTab(t, "b", -1).map((x) => x.key)).toEqual(["b", "a", "c"]);
    expect(moveTab(t, "a", -1)).toBe(t);
    expect(stepTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(pushClosed(["x"], "about:blank")).toEqual(["x"]);
    expect(pushClosed(["x"], "http://y")).toEqual(["x", "http://y"]);
  });
});

// ---- the app model against a fake bridge (stands in for the connection broker)

type Handler = (params: any, state: Record<string, any>) => unknown;
function fakeBridge(handlers: Record<string, Handler>, log: { method: string; params: any }[]) {
  let listener: ((m: { connId: number; message: string }) => void) | undefined;
  let next = 0;
  return {
    daemon: {
      open: async () => ++next,
      sendMessage: async (connId: number, message: string) => {
        const m = JSON.parse(message);
        log.push({ method: m.method.replace("rigwell.", ""), params: m.params });
        const h = handlers[m.method.replace("rigwell.", "")];
        const reply = h ? (() => { try { return { type: "response", id: m.id, result: h(m.params, {}) }; } catch (e: any) { return { type: "response", id: m.id, error: { code: e.code ?? -32603, message: e.message } }; } })()
          : { type: "response", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
        queueMicrotask(() => listener?.({ connId, message: JSON.stringify(reply) }));
      },
      close: async () => {}, onMessage: (cb: any) => { listener = cb; return () => {}; }, onClosed: () => () => {}, onStatus: () => () => {}, status: async () => ({ state: "running" }),
    },
    userSettings: { get: async () => ({ trustedFolders: { "/trusted": {} } }), update: async (p: any) => p, trustFolder: async () => ({}) },
    settings: { get: async () => ({}), onChanged: () => () => {} },
    view: { set: async () => {} },
  };
}

describe("app model over a fake broker", () => {
  const log: { method: string; params: any }[] = [];
  let modelMod: typeof import("../../desktop/renderer/lib/app-model.ts");
  let useLegacy = false;
  beforeAll(async () => {
    (globalThis as any).window = {
      rigwell: fakeBridge({
        list_sessions: () => {
          if (useLegacy) throw Object.assign(new Error("Method not found"), { code: -32601 });
          return { sessions: [{ sessionId: "s1", title: "Pinned one", cwd: "/p", updatedAt: Date.now(), pinned: true, archivedAt: null }, { sessionId: "s2", title: "Gone", cwd: "/p", updatedAt: Date.now(), archivedAt: Date.now() }] };
        },
        "daemon.list_sessions": () => ({ sessions: [{ id: "s3", title: "Legacy", cwd: "/p", updatedAt: Date.now() }] }),
        list_models: () => ({ models: [{ id: "fake", displayName: "Fake", modelProvider: "anthropic" }] }),
        load_session: () => ({ sessionId: "s1" }), rename_session: () => ({}), mission_list: () => ({ missions: [{ sessionId: "s1", state: "running", title: "Build it" }] }),
        list_automations: () => ({ automations: [] }), create_automation: (p: any) => ({ automation: { id: "x", name: p.name } }), run_automation: () => ({ runId: "r1" }),
      }, log),
      localStorage: undefined,
    };
    modelMod = await import("../../desktop/renderer/lib/app-model.ts");
  });
  afterAll(() => { delete (globalThis as any).window; });

  test("refresh uses list_sessions (pinned, archived) and maps model providers", async () => {
    await modelMod.app.refresh();
    const s = modelMod.app.getSnapshot();
    expect(s.sessions.map((x) => [x.id, x.pinned, x.archivedAt != null])).toEqual([["s1", true, false], ["s2", false, true]]);
    expect(s.models[0].provider).toBe("anthropic");
    expect(log.some((l) => l.method === "list_sessions" && l.params.includeArchived === true)).toBe(true);
  });

  test("falls back to daemon.list_sessions when the daemon predates list_sessions", async () => {
    useLegacy = true;
    await modelMod.app.refresh();
    expect(modelMod.app.getSnapshot().sessions.map((x) => x.id)).toEqual(["s3"]);
    useLegacy = false;
  });

  test("rename from a menu loads the session and calls rename_session", async () => {
    log.length = 0;
    await modelMod.app.sessionAction({ id: "s1", title: "Pinned one", cwd: "/p", updatedAt: 1 }, "rename", "Better title");
    const methods = log.map((l) => l.method);
    expect(methods.indexOf("load_session")).toBeGreaterThanOrEqual(0);
    expect(log.find((l) => l.method === "rename_session")?.params).toEqual({ title: "Better title" });
  });

  test("Mission Control and Automations calls go through the control connection", async () => {
    expect((await modelMod.app.request("mission_list")).missions[0].state).toBe("running");
    const built = buildCreate({ name: "N", preset: "hourly", custom: "", instructions: "go", workingDirectory: "", trigger: "schedule" });
    if ("error" in built) throw new Error(built.error);
    expect((await modelMod.app.request("create_automation", built.params)).automation.id).toBe("x");
    expect((await modelMod.app.request("run_automation", { id: "x" })).runId).toBe("r1");
  });
});

import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { saveSyncConfig, validateConfig } from "../../src/sync/config.ts";
import { collectSnapshot } from "../../src/sync/snapshot.ts";
import { restoreSyncedItem, syncedItem, syncNow, syncStatus } from "../../src/sync/service.ts";
import { SessionLease } from "../../src/sync/lease.ts";
import { SyncRepository } from "../../src/sync/target.ts";
import { createSession } from "../../src/storage/transcript.ts";

test("folder sync redacts selected data, keeps concurrent copies and restores inactive metadata", async () => {
  const env = tmpEnv(), a = env.rigwellHome, b = join(env.root, "other"), folder = join(env.root, "target");
  const config = { version: 1, folderIsAuthority: true, target: { kind: "folder", path: folder }, kinds: ["session", "automation", "mission", "workstream", "settings"], settings: ["diffMode"] };
  try {
    saveSyncConfig(config, a); saveSyncConfig(config, b);
    const session = createSession({ id: "fixture-session", cwd: env.root, title: "secret fixture-value" });
    writeJson(join(a, "settings.json"), { diffMode: "unified", apiKey: "fixture-value", hooks: { command: "must not sync" } });
    writeJson(join(a, "automations", "daily", "secrets.json"), { secret: "never this file" });
    writeJson(join(a, "automations", "daily", "state.json"), { id: "stable-automation", runCount: 1, retry: { at: Date.now() - 1, payload: "fixture-value" } });
    writeFileSync(join(a, "automations", "daily", "HEARTBEAT.md"), "---\nname: daily\nschedule: 0 9 * * *\npaused: false\n---\nReport fixture-value\n");
    writeJson(join(a, "missions", "mission-one", "state.json"), { state: "running", missionId: "mission-one" });
    writeJson(join(a, "workstreams", "work-one", "workstream.json"), { state: "active", id: "work-one" });
    writeJson(join(a, "workstreams", "work-one", "roster.json"), [{ agentId: "one", status: "working" }]);
    const first = await syncNow({ home: a, owner: "a", secrets: ["fixture-value"] }); expect(first.items).toHaveLength(5);
    const stored = readFileSync(join(folder, ".rigwell-sync", "sync.json"), "utf8");
    expect(stored).not.toContain("fixture-value"); expect(stored).not.toContain("secrets.json"); expect(stored).not.toContain("must not sync");
    await syncNow({ home: b, owner: "b", secrets: [] });
    expect(existsSync(join(b, "automations", "daily", "HEARTBEAT.md"))).toBe(false);
    await restoreSyncedItem("automation/daily", { home: b, owner: "b" });
    expect(readFileSync(join(b, "automations", "daily", "HEARTBEAT.md"), "utf8")).toContain("paused: true");
    const automation = JSON.parse(readFileSync(join(b, "automations", "daily", "state.json"), "utf8")); expect(automation.id).toBe("stable-automation"); expect(automation.retry).toBeUndefined();
    await restoreSyncedItem("mission/mission-one", { home: b, owner: "b" }); expect(JSON.parse(readFileSync(join(b, "missions", "mission-one", "state.json"), "utf8")).state).toBe("paused");
    await restoreSyncedItem("workstream/work-one", { home: b, owner: "b" }); expect(JSON.parse(readFileSync(join(b, "workstreams", "work-one", "roster.json"), "utf8"))[0].status).toBe("interrupted");
    writeJson(join(b, "settings.json"), { apiKey: "local-only", diffMode: "github" });
    await restoreSyncedItem("settings/user", { home: b, owner: "b" });
    expect(JSON.parse(readFileSync(join(b, "settings.json"), "utf8"))).toEqual({ apiKey: "local-only", diffMode: "unified" });
    await restoreSyncedItem("session/fixture-session", { home: b, owner: "b", cwd: env.root });
    expect(syncStatus(b).items.find((i) => i.key === "session/fixture-session")?.owner).toBe("b"); // Explicit restore transfers ownership.
    writeFileSync(session.transcriptPath, readFileSync(session.transcriptPath, "utf8").replace("secret fixture-value", "edited on a"));
    const conflict = await syncNow({ home: a, owner: "a", secrets: [] });
    expect(conflict.conflicts.some((c) => c.key === "session/fixture-session")).toBe(true);
    expect(syncedItem("session/fixture-session", conflict.conflicts.find((c) => c.key === "session/fixture-session")!.hash, a).files["fixture-session.jsonl"]).toContain("edited on a");
    expect(existsSync(join(a, "sync", "session-index.json"))).toBe(true);
  } finally { env.cleanup(); }
});

test("private git sync uses only its dedicated branch and preserves both writers", async () => {
  const env = tmpEnv(), remote = join(env.root, "bare.git"), a = env.rigwellHome, b = join(env.root, "b");
  try {
    const init = Bun.spawnSync(["git", "init", "--bare", remote], { windowsHide: true }); expect(init.exitCode).toBe(0);
    const config = { version: 1, target: { kind: "git", remote, private: true }, kinds: ["settings"], settings: ["diffMode"] };
    saveSyncConfig(config, a); saveSyncConfig(config, b);
    writeJson(join(a, "settings.json"), { diffMode: "github" }); writeJson(join(b, "settings.json"), { diffMode: "unified" });
    await syncNow({ home: a, owner: "a", secrets: [] });
    const result = await syncNow({ home: b, owner: "b", secrets: [] }); expect(result.conflicts).toHaveLength(1);
    const branches = Bun.spawnSync(["git", "--git-dir", remote, "for-each-ref", "--format=%(refname)"]); expect(branches.stdout.toString().trim()).toBe("refs/heads/rigwell-sync-v1");
    const repo = new SyncRepository(config.target as any, join(a, "test-git"));
    expect((await repo.transaction((d) => d.items["settings/user"]!.owner))).toBe("a");
  } finally { env.cleanup(); }
}, 10_000);

test("session lease denies a second engine, releases, and interrupts on renewal failure", async () => {
  const env = tmpEnv(), target = join(env.root, "target"), config = validateConfig({ version: 1, folderIsAuthority: true, target: { kind: "folder", path: target }, kinds: ["session"], settings: [] }, env.rigwellHome);
  let losses = 0;
  const a = new SessionLease("session/fixture", "a", config, env.rigwellHome, () => { losses++; }, 200);
  const b = new SessionLease("session/fixture", "b", config, join(env.root, "b"), () => {});
  try {
    await a.acquire(); let denied: unknown; try { await b.acquire(); } catch (e) { denied = e; } expect(String(denied)).toContain("owned by a");
    const authorityFile = join(target, ".rigwell-sync", "sync.json"), original = readFileSync(authorityFile, "utf8");
    writeFileSync(authorityFile, "{}");
    await new Promise((r) => setTimeout(r, 100)); expect(losses).toBe(1);
    let stale: unknown; try { await a.acquire(); } catch (e) { stale = e; } expect(String(stale)).toContain("ownership was lost");
    writeFileSync(authorityFile, original);
    await a.release(); await b.acquire(); await b.release();
  } finally { await a.release().catch(() => {}); await b.release().catch(() => {}); env.cleanup(); }
});

test("sync configuration excludes executable settings, embedded credentials and the runtime home", () => {
  const env = tmpEnv();
  const config = { version: 1, folderIsAuthority: true, target: { kind: "folder", path: join(env.root, "target") }, kinds: ["settings"], settings: [] };
  try {
    expect(() => validateConfig({ ...config, settings: ["hooks"] })).toThrow("selections");
    expect(() => validateConfig({ ...config, target: { kind: "folder", path: env.root } }, env.rigwellHome)).toThrow("outside");
    for (const remote of ["https://user:secret@example.test/repo", "ext::command", "-option"]) expect(() => validateConfig({ ...config, target: { kind: "git", remote, private: true } })).toThrow();
  } finally { env.cleanup(); }
});

test("offline folder replicas retain concurrent packets and require a separate lease authority", async () => {
  const env = tmpEnv(), a = env.rigwellHome, b = join(env.root, "b"), fa = join(env.root, "replica-a"), fb = join(env.root, "replica-b"), authority = join(env.root, "authority");
  const config = (folder: string) => ({ version: 1, target: { kind: "folder", path: folder, replicated: true }, leaseTarget: { kind: "folder", path: authority }, kinds: ["settings"], settings: ["diffMode"] });
  const replicate = () => {
    for (const [from, to] of [[fa, fb], [fb, fa]]) for (const name of readdirSync(join(from!, ".rigwell-sync"))) if (name.startsWith("packet-")) copyFileSync(join(from!, ".rigwell-sync", name), join(to!, ".rigwell-sync", name));
  };
  try {
    expect(() => validateConfig({ ...config(fa), leaseTarget: undefined }, a)).toThrow("separate");
    saveSyncConfig(config(fa), a); saveSyncConfig(config(fb), b);
    writeJson(join(a, "settings.json"), { diffMode: "github" }); writeJson(join(b, "settings.json"), { diffMode: "unified" });
    await syncNow({ home: a, owner: "a", secrets: [] }); await syncNow({ home: b, owner: "b", secrets: [] });
    replicate(); const first = await syncNow({ home: a, owner: "a", secrets: [] });
    expect(first.conflicts).toHaveLength(1);
    const values = [syncedItem("settings/user", undefined, a), ...first.conflicts.map((c) => syncedItem(c.key, c.hash, a))].map((i) => JSON.parse(i.files["settings.json"]!).diffMode).sort();
    expect(values).toEqual(["github", "unified"]);
    replicate(); expect((await syncNow({ home: b, owner: "b", secrets: [] })).conflicts).toHaveLength(1);
  } finally { env.cleanup(); }
});

test("replicated linear revisions can return to earlier content without becoming a conflict cycle", async () => {
  const env = tmpEnv(), target = join(env.root, "replica"), authority = join(env.root, "authority");
  try {
    saveSyncConfig({ version: 1, target: { kind: "folder", path: target, replicated: true }, leaseTarget: { kind: "folder", path: authority }, kinds: ["settings"], settings: ["diffMode"] });
    for (const diffMode of ["github", "unified", "github"]) {
      writeJson(join(env.rigwellHome, "settings.json"), { diffMode });
      expect((await syncNow({ secrets: [], owner: "a" })).conflicts).toHaveLength(0);
    }
    expect((await syncNow({ secrets: [], owner: "a" })).conflicts).toHaveLength(0);
  } finally { env.cleanup(); }
});

test("a stale lease permits takeover", async () => {
  const env = tmpEnv(), target = join(env.root, "authority"), config = validateConfig({ version: 1, folderIsAuthority: true, target: { kind: "folder", path: target }, kinds: ["session"], settings: [] });
  const lease = new SessionLease("session/stale", "new", config, env.rigwellHome, () => {});
  try {
    const repo = new SyncRepository(config.target, join(env.root, "cache"));
    await repo.transaction((d) => { d.leases["session/stale"] = { owner: "old", token: "old-token", expiresAt: Date.now() - 1 }; });
    await lease.acquire(); expect(await repo.transaction((d) => d.leases["session/stale"]!.owner)).toBe("new");
  } finally { await lease.release(); env.cleanup(); }
});

test("concurrent private git writers compare and swap instead of losing either copy", async () => {
  const env = tmpEnv(), remote = join(env.root, "bare.git"), a = env.rigwellHome, b = join(env.root, "other");
  try {
    expect(Bun.spawnSync(["git", "init", "--bare", remote], { windowsHide: true }).exitCode).toBe(0);
    const config = { version: 1, target: { kind: "git", remote, private: true }, kinds: ["settings"], settings: ["diffMode"] };
    saveSyncConfig(config, a); saveSyncConfig(config, b);
    writeJson(join(a, "settings.json"), { diffMode: "github" }); writeJson(join(b, "settings.json"), { diffMode: "unified" });
    await Promise.all([syncNow({ home: a, owner: "a", secrets: [] }), syncNow({ home: b, owner: "b", secrets: [] })]);
    const state = await syncNow({ home: a, owner: "a", secrets: [] });
    expect(state.items).toHaveLength(1); expect(state.conflicts).toHaveLength(1);
    expect(new Set([state.items[0]!.owner, state.conflicts[0]!.owner])).toEqual(new Set(["a", "b"]));
  } finally { env.cleanup(); }
}, 10_000);

test("a killed coordinator process leaves no stale transaction lock", async () => {
  const env = tmpEnv(), target = join(env.root, "authority"), root = join(target, ".rigwell-sync"); mkdirSync(root, { recursive: true });
  const code = `import {Database} from 'bun:sqlite'; const d=new Database(${JSON.stringify(join(root, "coordinator.db"))}); d.exec('BEGIN IMMEDIATE'); console.log('ready'); setInterval(()=>{},10000); await new Promise(()=>{});`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  try {
    const reader = child.stdout.getReader(); const ready = await reader.read(); expect(new TextDecoder().decode(ready.value)).toContain("ready"); reader.releaseLock();
    expect(child.exitCode).toBeNull(); child.kill(); await child.exited;
    const repo = new SyncRepository({ kind: "folder", path: target }, join(env.root, "cache"));
    expect(await repo.transaction(() => "recovered")).toBe("recovered");
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } env.cleanup(); }
}, 5000);

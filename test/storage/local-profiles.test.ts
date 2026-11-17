import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "./helpers.ts";
import { activateLocalProfile, applyProfileOption, createLocalProfile, listLocalProfiles, localProfileHome, profileId, profileOption, profileSwitchArgs, readLocalProfile, updateLocalProfile } from "../../src/storage/local-profiles.ts";
import { defaultCredentialStore, lookupCredential, setCredentialStore, storeCredential } from "../../src/storage/credentials.ts";
import { policyPaths } from "../../src/storage/policy.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";

function fixture() {
  const previous = Object.fromEntries(["RIGWELL_PROFILE", "RIGWELL_PROFILE_ROOT", "RIGWELL_CREDENTIALS"].map((k) => [k, process.env[k]])), env = tmpEnv();
  delete process.env.RIGWELL_PROFILE; delete process.env.RIGWELL_PROFILE_ROOT; process.env.RIGWELL_CREDENTIALS = "file"; setCredentialStore(undefined);
  return { ...env, cleanup() { closeSessionIndexes(); setCredentialStore(undefined); process.env.RIGWELL_HOME = env.rigwellHome; env.cleanup(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test("profile metadata, selection and restart arguments preserve the default home and refuse path/link escapes", () => {
  const env = fixture(); try {
    expect(listLocalProfiles(env.rigwellHome).map((p) => p.id)).toEqual(["default"]);
    const row = createLocalProfile(env.rigwellHome, "work", "Work", "Editor"); expect(row.role).toBe("Editor"); expect(existsSync(join(localProfileHome(env.rigwellHome, "work"), "settings.json"))).toBe(false);
    updateLocalProfile(env.rigwellHome, "work", "Updated", "Reviewer"); expect(readLocalProfile(env.rigwellHome, "work").name).toBe("Updated");
    for (const id of ["../escape", "a/b", "a\\b", "", "Upper", "a.", "a "]) expect(() => profileId(id)).toThrow();
    expect(() => createLocalProfile(env.rigwellHome, "work")).toThrow(); expect(() => updateLocalProfile(env.rigwellHome, "work", "", "")).toThrow();
    const isolated: Record<string, string | undefined> = { RIGWELL_HOME: env.rigwellHome };
    expect(applyProfileOption(["exec", "--profile", "work", "prompt"], isolated)).toEqual(["exec", "prompt"]); expect(isolated.RIGWELL_HOME).toBe(localProfileHome(env.rigwellHome, "work"));
    applyProfileOption(["--profile", "default", "exec"], isolated); expect(isolated.RIGWELL_HOME).toBe(env.rigwellHome); expect(profileOption(["exec", "--", "--profile", "literal"]).id).toBeUndefined();
    expect(profileSwitchArgs(["app", "--profile", "work", "--route=/settings/profiles"], "default")).toEqual(["app", "--route=/settings/profiles", "--profile", "default"]); expect(() => profileOption(["--profile", "work", "--profile", "default"])).toThrow();
    const outside = join(env.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(env.rigwellHome, "profiles", "linked"), process.platform === "win32" ? "junction" : "dir"); expect(() => readLocalProfile(env.rigwellHome, "linked")).toThrow("link");
  } finally { env.cleanup(); }
});

test("named profiles isolate credential files and lookup caches while base policy remains authoritative", () => {
  const env = fixture(); try {
    storeCredential("shared", "default-fixture"); expect(lookupCredential("shared")).toBe("default-fixture"); createLocalProfile(env.rigwellHome, "work");
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, maxAutonomyLevel: "low" });
    const work = activateLocalProfile("work"); expect(lookupCredential("shared")).toBeUndefined(); storeCredential("shared", "work-fixture"); expect(lookupCredential("shared")).toBe("work-fixture");
    writeJson(join(work, "settings.json"), { sessionDefaultSettings: { autonomyLevel: "high" } }); writeJson(join(work, "policy.json"), { schemaVersion: 1, maxAutonomyLevel: "high" });
    expect(policyPaths()).toContain(join(env.rigwellHome, "policy.json")); expect(loadSettings({ cwd: env.root }).settings.sessionDefaultSettings?.autonomyLevel).toBe("low");
    activateLocalProfile("default"); expect(lookupCredential("shared")).toBe("default-fixture"); expect(JSON.parse(readFileSync(join(work, "credentials.json"), "utf8")).shared).toBe("work-fixture");
  } finally { env.cleanup(); }
});

test("actual keychain backend construction scopes named accounts without altering legacy default accounts", () => {
  const env = fixture(), vault = new Map<string, string>(); try {
    delete process.env.RIGWELL_CREDENTIALS;
    const run = (cmd: string[]) => { const account = cmd[cmd.indexOf("-a") + 1]!; if (cmd[1] === "add-generic-password") { vault.set(account, cmd[cmd.indexOf("-w") + 1]!); return { code: 0, stdout: "" }; } return { code: vault.has(account) ? 0 : 44, stdout: vault.get(account) ?? "" }; };
    const legacy = defaultCredentialStore("darwin", run).backends[0]!; legacy.set("shared", "default-fixture"); expect(vault.has("shared")).toBe(true);
    createLocalProfile(env.rigwellHome, "work"); createLocalProfile(env.rigwellHome, "personal"); activateLocalProfile("work"); const work = defaultCredentialStore("darwin", run).backends[0]!;
    expect(work.get("shared")).toBeUndefined(); work.set("shared", "work-fixture"); activateLocalProfile("personal"); expect(defaultCredentialStore("darwin", run).backends[0]!.get("shared")).toBeUndefined();
    activateLocalProfile("work"); expect(defaultCredentialStore("darwin", run).backends[0]!.get("shared")).toBe("work-fixture"); expect(legacy.get("shared")).toBe("default-fixture"); expect(vault.size).toBe(2);
  } finally { env.cleanup(); }
});

test("real CLI profiles have independent keys, settings and session search indexes on the same repository", async () => {
  const env = fixture(), first = await startFakeAnthropic([{ text: "defaultmarker" }]), second = await startFakeAnthropic([{ text: "workmarker" }]);
  const cli = (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), ...args], { cwd: env.root, env: { ...process.env, RIGWELL_HOME: env.rigwellHome, RIGWELL_PROFILE_ROOT: undefined, RIGWELL_PROFILE: undefined, RIGWELL_CREDENTIALS: "file" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const run = async (args: string[], input?: string) => { const child = cli(...args); child.stdin.write(input ?? ""); child.stdin.end(); const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect(code).toBe(0); return { out, err }; };
  try {
    await run(["profile", "create", "work", "Work"]); const work = localProfileHome(env.rigwellHome, "work");
    await run(["credential", "set", "shared"], "default-fixture\n"); await run(["--profile", "work", "credential", "set", "shared"], "work-fixture\n");
    expect(JSON.parse(readFileSync(join(env.rigwellHome, "credentials.json"), "utf8")).shared).toBe("default-fixture"); expect(JSON.parse(readFileSync(join(work, "credentials.json"), "utf8")).shared).toBe("work-fixture");
    for (const [home, fake] of [[env.rigwellHome, first], [work, second]] as const) writeJson(join(home, "settings.json"), { autoSessionTitle: false, customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "keychain:shared" }] });
    expect((await run(["exec", "--cwd", env.root, "Default fixture request"])).out).toContain("defaultmarker"); expect((await run(["--profile", "work", "exec", "--cwd", env.root, "Work fixture request"])).out).toContain("workmarker");
    expect(first.headers[0]!["x-api-key"]).toBe("default-fixture"); expect(second.headers[0]!["x-api-key"]).toBe("work-fixture");
    expect(JSON.parse((await run(["--profile", "work", "sessions", "search", "workmarker", "--json", "--cwd", env.root])).out)).toHaveLength(1); expect(JSON.parse((await run(["sessions", "search", "workmarker", "--json", "--cwd", env.root])).out)).toHaveLength(0);
    expect((await run(["profile", "list"])).out).toContain('"active":"default"'); expect((await run(["--profile", "work", "profile", "list"])).out).toContain('"active":"work"');
  } finally { first.stop(); second.stop(); env.cleanup(); }
}, 20_000);

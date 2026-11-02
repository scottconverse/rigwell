// Secrets and environments: storage, masked lists, injection into Execute and hooks, and no leaks into transcripts or notifications.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { listSecrets, maskSecret, redactSecrets, resolveEnvironment, setEnvironment, setSecret } from "../../src/secrets/store.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { lastToolResult, makeRepo } from "../e2e/helpers.ts";
import { inproc } from "../e2e/inproc.ts";
import { tmpEnv } from "../storage/helpers.ts";

let env: ReturnType<typeof tmpEnv>;
const servers: FakeServer[] = [];
beforeEach(() => { process.env.RIGWELL_TRUST_CWD = "1"; env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()])); });
afterEach(() => { setCredentialStore(undefined); env.cleanup(); });
afterAll(() => servers.forEach((s) => s.stop()));

const SECRET = "sk-live-9f8e7d6c5b4a39281706";

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test("secret values live only in the credential store; the index and lists hold names and masks", async () => {
  const c = inproc();
  const r = await c.call("set_secret", { name: "gh-token", value: SECRET });
  expect(r).toEqual({ name: "gh-token", mask: `****${SECRET.slice(-4)}`, backend: "file" });
  expect(JSON.stringify(r)).not.toContain(SECRET);
  const list = await c.call("list_secrets", {});
  expect(list.secrets).toHaveLength(1);
  expect(list.secrets[0]).toMatchObject({ name: "gh-token", mask: `****${SECRET.slice(-4)}`, usedBy: [] });
  expect(JSON.stringify(list)).not.toContain(SECRET);
  // The index file has no value; the credential file (mode 0600) has it.
  expect(readFileSync(path.join(env.rigwellHome, "secrets.json"), "utf8")).not.toContain(SECRET);
  expect(statSync(path.join(env.rigwellHome, "secrets.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(path.join(env.rigwellHome, "credentials.json"), "utf8")).toContain(SECRET);
  // Short values show no characters at all.
  expect(maskSecret("short")).toBe("****");
  // Update keeps createdAt; delete removes value and index entry.
  const created = listSecrets()[0]!.createdAt;
  setSecret("gh-token", SECRET + "x");
  expect(listSecrets()[0]!.createdAt).toBe(created);
  expect(await c.call("delete_secret", { name: "gh-token" })).toMatchObject({ deleted: true });
  expect((await c.call("list_secrets", {})).secrets).toEqual([]);
  expect(readFileSync(path.join(env.rigwellHome, "credentials.json"), "utf8")).not.toContain("secret:gh-token");
  await expect(c.call("set_secret", { name: "bad name!", value: "v" })).rejects.toThrow(/name must be/);
  await expect(c.call("set_secret", { name: "ok", value: "" })).rejects.toThrow(/non-empty/);
});

test("environments: list shows secret references, never values; validation", async () => {
  const c = inproc();
  await c.call("set_secret", { name: "gh-token", value: SECRET });
  const set = await c.call("set_environment", { name: "ci", description: "CI vars", vars: { GH_TOKEN: { secret: "gh-token" }, MODE: "test", GONE: { secret: "missing-one" } } });
  expect(set.environment.vars).toEqual([
    { name: "GH_TOKEN", kind: "secret", secret: "gh-token", missing: false },
    { name: "GONE", kind: "secret", secret: "missing-one", missing: true },
    { name: "MODE", kind: "literal", value: "test" },
  ]);
  const list = await c.call("list_environments", {});
  expect(list.environments[0]).toMatchObject({ name: "ci", description: "CI vars" });
  expect(JSON.stringify(list)).not.toContain(SECRET);
  expect((await c.call("list_secrets", {})).secrets[0].usedBy).toEqual(["ci"]);
  expect(readFileSync(path.join(env.rigwellHome, "environments.json"), "utf8")).not.toContain(SECRET);
  await expect(c.call("set_environment", { name: "x", vars: { "1BAD": "v" } })).rejects.toThrow(/invalid variable name/);
  await expect(c.call("set_environment", { name: "x", vars: { LD_PRELOAD: "/x.so" } })).rejects.toThrow(/protected/);
  await expect(c.call("set_environment", { name: "x", vars: { A: 5 } })).rejects.toThrow(/use a string/);
  expect(() => resolveEnvironment("ci")).toThrow(/not stored/);
  setEnvironment("ok", { GH_TOKEN: { secret: "gh-token" } });
  expect(resolveEnvironment("ok").env.GH_TOKEN).toBe(SECRET);
  expect(await c.call("delete_environment", { name: "ci" })).toEqual({ deleted: true });
  expect(await c.call("delete_environment", { name: "ci" })).toEqual({ deleted: false });
});

test("redactSecrets replaces longer values first and ignores tiny ones", () => {
  expect(redactSecrets("a abcdef-long abcdef b xy", { s1: "abcdef", s2: "abcdef-long", t: "xy" })).toBe("a [secret:s2] [secret:s1] b xy");
});

test("session environment reaches Execute and hooks, and never the prompt, transcript, notifications or model", async () => {
  const fake = await startFakeAnthropic([
    () => ({ toolCalls: [{ name: "Execute", input: { command: 'echo "len=${#MY_TOKEN} mode=$MODE"; echo "$MY_TOKEN"', riskLevel: "low", riskReason: "Prints variables." } }] }),
    () => ({ text: "done" }),
  ]);
  servers.push(fake);
  writeFileSync(path.join(env.rigwellHome, "settings.json"), JSON.stringify({
    customModels: [{ model: "fake", displayName: "Fake", provider: "anthropic", baseUrl: fake.url, apiKey: "test-key-not-real" }],
  }));
  const repo = makeRepo();
  // A project hook that records the variable it sees (hooks get the environment too).
  mkdirSync(path.join(repo, ".rigwell"), { recursive: true });
  const hookOut = path.join(env.root, "hook-saw.txt");
  writeFileSync(path.join(repo, ".rigwell", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s' "$MY_TOKEN" > '${hookOut}'` }] }] },
  }));
  const c = inproc();
  await c.call("set_secret", { name: "tok", value: SECRET });
  await c.call("set_environment", { name: "dev", vars: { MY_TOKEN: { secret: "tok" }, MODE: "dev" } });
  await expect(c.call("initialize_session", { cwd: repo, autonomyLevel: "high", environment: "nope" })).rejects.toThrow(/No environment named/);
  const init = await c.call("initialize_session", { cwd: repo, autonomyLevel: "high", environment: "dev" });
  expect(JSON.stringify(init)).not.toContain(SECRET);
  await c.turn("print the variables");

  // The command saw the real value (its length), but the output the model got has it redacted.
  const result = lastToolResult(fake.requests[1]);
  expect(result).toContain(`len=${SECRET.length} mode=dev`);
  expect(result).toContain("[secret:tok]");
  expect(readFileSync(hookOut, "utf8")).toBe(SECRET);

  // Nothing carries the value: model requests, notifications, every file under RIGWELL_HOME except the credential file.
  for (const body of fake.requests) expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(JSON.stringify(c.out)).not.toContain(SECRET);
  const leaks = allFiles(env.rigwellHome).filter((f) => !f.endsWith("credentials.json") && readFileSync(f, "utf8").includes(SECRET));
  expect(leaks).toEqual([]);
  expect(allFiles(env.rigwellHome).some((f) => f.endsWith(".jsonl"))).toBe(true);
  // The session remembers only the environment's name.
  const saved = allFiles(env.rigwellHome).find((f) => f.endsWith(".settings.json"))!;
  expect(JSON.parse(readFileSync(saved, "utf8")).environment).toBe("dev");
  await c.call("close_session", {});

  // Resuming the session re-applies the environment by name.
  const again = inproc();
  await again.call("load_session", { sessionId: init.sessionId, cwd: repo });
  expect(JSON.stringify(again.out)).not.toContain(SECRET);
  await again.call("close_session", {});
}, 30000);

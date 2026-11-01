// Credential store (spec 12.2): real file backend, keychain backends through a fake command runner, settings references.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import path from "node:path";
import {
  CredentialStore, FileBackend, MacKeychainBackend, SecretToolBackend, defaultCredentialStore, setCredentialStore,
  type CommandRunner,
} from "../../src/storage/credentials.ts";
import { validateCustomModels } from "../../src/storage/models.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => { env = tmpEnv(); });
afterEach(() => { setCredentialStore(undefined); env.cleanup(); });

/** A fake keychain: runs the `security` / `secret-tool` commands against an in-memory map and records every call. */
function fakeRunner() {
  const vault = new Map<string, string>();
  const calls: { cmd: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, input) => {
    calls.push({ cmd, input });
    const arg = (flag: string) => cmd[cmd.indexOf(flag) + 1]!;
    if (cmd[0] === "security") {
      const account = arg("-a");
      if (cmd[1] === "find-generic-password") return vault.has(account) ? { code: 0, stdout: vault.get(account)! + "\n" } : { code: 44, stdout: "" };
      if (cmd[1] === "add-generic-password") { vault.set(account, arg("-w")); return { code: 0, stdout: "" }; }
      if (cmd[1] === "delete-generic-password") return { code: vault.delete(account) ? 0 : 44, stdout: "" };
    }
    if (cmd[0] === "secret-tool") {
      const account = cmd[cmd.indexOf("account") + 1]!;
      if (cmd[1] === "lookup") return vault.has(account) ? { code: 0, stdout: vault.get(account)! } : { code: 1, stdout: "" };
      if (cmd[1] === "store") { vault.set(account, input ?? ""); return { code: 0, stdout: "" }; }
      if (cmd[1] === "clear") { vault.delete(account); return { code: 0, stdout: "" }; }
    }
    return { code: 127, stdout: "" };
  };
  return { run, vault, calls };
}

test("file backend: round trip, mode 0600, delete", () => {
  const b = new FileBackend();
  expect(b.get("k")).toBeUndefined();
  expect(b.set("k", "secret-1")).toBe(true);
  expect(b.get("k")).toBe("secret-1");
  const file = path.join(env.rigwellHome, "credentials.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  b.set("k2", "secret-2");
  expect(b.names().sort()).toEqual(["k", "k2"]);
  expect(b.delete("k")).toBe(true);
  expect(b.get("k")).toBeUndefined();
  expect(b.get("k2")).toBe("secret-2");
  expect(b.delete("missing")).toBe(false);
});

test("macOS backend builds security commands and reads the value back", () => {
  const f = fakeRunner();
  const b = new MacKeychainBackend(f.run, () => true);
  expect(b.set("anthropic", "sk-abc")).toBe(true);
  expect(f.calls[0]!.cmd).toEqual(["security", "add-generic-password", "-U", "-s", "rigwell", "-a", "anthropic", "-w", "sk-abc"]);
  expect(b.get("anthropic")).toBe("sk-abc");
  expect(f.calls[1]!.cmd).toEqual(["security", "find-generic-password", "-s", "rigwell", "-a", "anthropic", "-w"]);
  expect(b.get("nope")).toBeUndefined();
  expect(b.delete("anthropic")).toBe(true);
  expect(b.get("anthropic")).toBeUndefined();
  expect(new MacKeychainBackend(f.run, () => false).available()).toBe(false);
});

test("secret-tool backend sends the value on stdin, never in the arguments", () => {
  const f = fakeRunner();
  const b = new SecretToolBackend(f.run, () => true);
  expect(b.set("openai", "sk-xyz")).toBe(true);
  expect(f.calls[0]!.cmd).toEqual(["secret-tool", "store", "--label=Rigwell openai", "service", "rigwell", "account", "openai"]);
  expect(f.calls[0]!.input).toBe("sk-xyz");
  expect(f.calls[0]!.cmd.join(" ")).not.toContain("sk-xyz");
  expect(b.get("openai")).toBe("sk-xyz");
  expect(b.delete("openai")).toBe(true);
  expect(b.get("openai")).toBeUndefined();
});

test("store: keychain first, file when the keychain is missing or refuses", () => {
  const f = fakeRunner();
  const keychain = new SecretToolBackend(f.run, () => true);
  const file = new FileBackend();
  const store = new CredentialStore([keychain, file]);
  expect(store.set("a", "1")).toBe("libsecret");
  expect(file.get("a")).toBeUndefined();
  expect(store.get("a")).toBe("1");

  const noKeychain = new CredentialStore([new SecretToolBackend(f.run, () => false), file]);
  expect(noKeychain.set("b", "2")).toBe("file");
  expect(noKeychain.get("b")).toBe("2");

  const refusing = new CredentialStore([new SecretToolBackend(() => ({ code: 1, stdout: "" }), () => true), file]);
  expect(refusing.set("c", "3")).toBe("file");
  expect(refusing.get("c")).toBe("3");

  expect(store.delete("a")).toBe(true);
  expect(store.get("a")).toBeUndefined();
});

test("default store: platform picks the keychain, RIGWELL_CREDENTIALS=file skips it", () => {
  const f = fakeRunner();
  expect(defaultCredentialStore("darwin", f.run).backends.map((b) => b.name)).toEqual(["macos-keychain", "file"]);
  expect(defaultCredentialStore("linux", f.run).backends.map((b) => b.name)).toEqual(["libsecret", "file"]);
  expect(defaultCredentialStore("win32", f.run).backends.map((b) => b.name)).toEqual(["file"]);
  process.env.RIGWELL_CREDENTIALS = "file";
  try { expect(defaultCredentialStore("linux", f.run).backends.map((b) => b.name)).toEqual(["file"]); }
  finally { delete process.env.RIGWELL_CREDENTIALS; }
});

test("settings: apiKey keychain:<name> resolves from the store; a plain apiKey still works; a missing one is a problem", () => {
  setCredentialStore(new CredentialStore([new FileBackend()]));
  new FileBackend().set("work", "sk-stored-1234");
  const base = { provider: "anthropic", baseUrl: "https://x.test" };
  const r = validateCustomModels({
    customModels: [
      { ...base, model: "a", apiKey: "keychain:work" },
      { ...base, model: "b", apiKey: "sk-plain-5678" },
      { ...base, model: "c", apiKey: "keychain:absent" },
    ],
  } as any, {});
  expect(r.models.map((m) => [m.model, m.apiKey])).toEqual([["a", "sk-stored-1234"], ["b", "sk-plain-5678"]]);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.message).toContain("no stored credential named \"absent\"");
});

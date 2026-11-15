import { expect, test } from "bun:test";
import { CredentialStore, WindowsCredentialBackend, type CredentialBackend, type CommandRunner } from "../../src/storage/credentials.ts";

test("Windows credential bridge uses stdin data, bounded UTF8 blobs and isolated targets", () => {
  const vault = new Map<string, string>(), calls: { cmd: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, input) => {
    calls.push({ cmd, input }); const r = JSON.parse(input!);
    if (r.op === "set") { vault.set(r.account, r.value); return { code: 0, stdout: "" }; }
    if (r.op === "delete") return { code: vault.delete(r.account) ? 0 : 1, stdout: "" };
    return vault.has(r.account) ? { code: 0, stdout: Buffer.from(vault.get(r.account)!).toString("base64") } : { code: 1, stdout: "" };
  };
  const b = new WindowsCredentialBackend(run, () => true), name = "profile:fixture:oauth/server", secret = "fixture-'\"\n✓";
  expect(b.get(name)).toBeUndefined(); expect(b.set(name, secret)).toBe(true); expect(b.get(name)).toBe(secret);
  expect(b.get("other")).toBeUndefined(); expect(b.set(name, "x".repeat(2560))).toBe(true);
  const count = calls.length; expect(b.set(name, "✓".repeat(854))).toBe(false); expect(b.set("bad\0name", secret)).toBe(false); expect(calls).toHaveLength(count);
  expect(calls.every((c) => !c.cmd.join(" ").includes(secret) && !c.cmd.join(" ").includes(name))).toBe(true);
  expect(b.delete(name)).toBe(true); expect(b.get(name)).toBeUndefined();
  const unavailable = new WindowsCredentialBackend(run, () => false); expect(unavailable.available()).toBe(false);
});

test("rotation between native storage and file fallback removes stale shadowing values, and cleanup failure is not success", () => {
  const memory = (name: string, limit: number): CredentialBackend => {
    const values = new Map<string, string>(); return { name, available: () => true, get: (k) => values.get(k), set(k, v) { if (v.length > limit) return false; values.set(k, v); return true; }, delete: (k) => values.delete(k) };
  };
  const native = memory("native", 5), file = memory("file", 100), store = new CredentialStore([native, file]);
  expect(store.set("a", "old")).toBe("native"); expect(store.set("a", "long replacement")).toBe("file"); expect(store.get("a")).toBe("long replacement"); expect(native.get("a")).toBeUndefined();
  expect(store.set("a", "new")).toBe("native"); expect(file.get("a")).toBeUndefined(); expect(store.get("a")).toBe("new");
  native.set("a", "old"); native.delete = () => false;
  expect(() => store.set("a", "long replacement")).toThrow("previous credential");
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { removeBrowserProfile } from "../../src/browser/cleanup.ts";
import { tmpEnv } from "../storage/helpers.ts";

test("profile cleanup handles a transient Windows-style lock without relying on runtime retry options", async () => {
  const env = tmpEnv(), profile = join(env.root, "owned-profile");
  mkdirSync(profile); writeFileSync(join(profile, "Preferences"), "fixture");
  let calls = 0;
  try {
    await removeBrowserProfile(profile, async (path, options) => {
      if (++calls === 1) throw Object.assign(new Error("Fixture helper still owns the file"), { code: "EBUSY" });
      await rm(path, options);
    });
    expect(calls).toBe(2); expect(existsSync(profile)).toBe(false);
  } finally { env.cleanup(); }
});

test("profile cleanup preserves a profile on a permanent error", async () => {
  const env = tmpEnv(), profile = join(env.root, "owned-profile"); mkdirSync(profile);
  let calls = 0, failure: unknown;
  try {
    try { await removeBrowserProfile(profile, async () => { calls++; throw Object.assign(new Error("Denied"), { code: "EACCES" }); }); }
    catch (error) { failure = error; }
    expect((failure as NodeJS.ErrnoException)?.code).toBe("EACCES");
    expect(calls).toBe(1); expect(existsSync(profile)).toBe(true);
  } finally { env.cleanup(); }
});

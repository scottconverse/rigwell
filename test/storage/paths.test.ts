import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { hostId, projectSlug, rigwellHome, sessionsDir, validateSessionId } from "../../src/storage/paths.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => { env = tmpEnv(); });
afterEach(() => env.cleanup());

test("rigwellHome honours RIGWELL_HOME", () => {
  expect(rigwellHome()).toBe(env.rigwellHome);
  expect(sessionsDir()).toBe(path.join(env.rigwellHome, "sessions"));
});

test("slug rule", () => {
  expect(projectSlug("C:\\Users\\scott")).toBe("-C-Users-scott");
  expect(projectSlug("C:/Users/scott/")).toBe("-C-Users-scott");
  // Step 2 makes the path absolute: on Windows "/x" is on the current drive, so the drive letter joins the slug.
  const drive = process.platform === "win32" ? path.parse(path.resolve("/")).root.slice(0, 1) + "-" : "";
  expect(projectSlug("/nonexistent/a_b/c.d-e")).toBe(`-${drive}nonexistent-a_b-c.d-e`);
  expect(projectSlug("/nonexistent/a/b///")).toBe(`-${drive}nonexistent-a-b`);
});

test("slug resolves symlinks when the path exists", () => {
  const real = path.join(env.root, "real");
  mkdirSync(real);
  const link = path.join(env.root, "link");
  symlinkSync(real, link);
  expect(projectSlug(link)).toBe(projectSlug(real));
});

test("validateSessionId", () => {
  expect(validateSessionId("abc-123")).toBe("abc-123");
  for (const bad of ["", "a/b", "a\\b", "..", "a..b", "a\0b"]) expect(() => validateSessionId(bad)).toThrow();
});

test("hostId creates host.json once and is stable", () => {
  const a = hostId();
  expect(hostId()).toBe(a);
  const j = JSON.parse(readFileSync(path.join(env.rigwellHome, "host.json"), "utf8"));
  expect(j.schemaVersion).toBe(1);
  expect(j.hostId).toBe(a);
  expect(typeof j.createdAt).toBe("number");
  expect(existsSync(path.join(env.rigwellHome, "host.json"))).toBe(true);
});

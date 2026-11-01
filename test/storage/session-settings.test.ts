import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSessionSettings, updateSessionSettings, writeSessionSettings } from "../../src/storage/session-settings.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => { env = tmpEnv(); });
afterEach(() => env.cleanup());

test("write is atomic, keeps .bak of previous, passes unknown fields through, falls back on corruption", () => {
  const f = { settingsPath: path.join(env.root, "s.settings.json") };
  expect(readSessionSettings(f)).toBeNull();
  writeSessionSettings(f, { model: "m1", futureField: { a: 1 } });
  expect(existsSync(f.settingsPath + ".bak")).toBe(false);
  updateSessionSettings(f, { model: "m2", assistantActiveTimeMs: 5 });
  expect(JSON.parse(readFileSync(f.settingsPath + ".bak", "utf8")).model).toBe("m1");
  const cur = readSessionSettings(f)!;
  expect(cur).toMatchObject({ model: "m2", futureField: { a: 1 }, assistantActiveTimeMs: 5 });
  expect(readdirSync(env.root).filter((n) => n.includes(".tmp-"))).toEqual([]);

  writeFileSync(f.settingsPath, "{ corrupt");
  expect(readSessionSettings(f)!.model).toBe("m1"); // from .bak
  // a corrupt main file must not clobber the good .bak
  writeSessionSettings(f, { model: "m3" });
  expect(JSON.parse(readFileSync(f.settingsPath + ".bak", "utf8")).model).toBe("m1");
  expect(readSessionSettings(f)!.model).toBe("m3");
});

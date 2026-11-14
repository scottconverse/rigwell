import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRemoteBundle, NativeArchive, runtimeFor, type RuntimeFetch } from "../../src/machines/bundle.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";

test("remote builds identify exact sources and runtime while excluding settings and dev-only packages", async () => {
  const env = tmpEnv();
  try {
    writeJson(join(env.root, "package.json"), { version: "0.1.0", dependencies: { runtime: "1" }, devDependencies: { development: "1" } });
    writeJson(join(env.root, "src", "fixture.json"), { value: "source" });
    writeJson(join(env.root, "settings.json"), { secret: "not-in-build" });
    writeJson(join(env.root, "node_modules/runtime/package.json"), { name: "runtime", dependencies: { transitive: "1" } });
    writeJson(join(env.root, "node_modules/transitive/package.json"), { name: "transitive" });
    writeJson(join(env.root, "node_modules/development/package.json"), { secret: "not-in-build" });
    const opts = { root: env.root, platform: "linux" as const, arch: "x64" as const, runtime: new Uint8Array([1, 2, 3]) };
    const first = await buildRemoteBundle(opts), second = await buildRemoteBundle(opts);
    expect(first.build).toBe(second.build);
    const files = await new NativeArchive(first.bytes).files();
    expect([...files.keys()].sort()).toEqual(["bun", "node_modules/runtime/package.json", "node_modules/transitive/package.json", "package.json", "remote-build.json", "src/fixture.json"]);
    const manifest = JSON.parse(await files.get("remote-build.json")!.text());
    expect(manifest.build).toBe(first.build); expect(manifest.runtime).toBe("1.4.4");
    writeFileSync(join(env.root, "src/fixture.json"), "changed");
    expect((await buildRemoteBundle(opts)).build).not.toBe(first.build);
    expect((await buildRemoteBundle({ ...opts, runtime: new Uint8Array([4]) })).build).not.toBe(first.build);
  } finally { env.cleanup(); }
});

test("cross-platform runtime downloads require official registry URLs and verified archive integrity", async () => {
  const target = process.platform === "win32" ? "linux" : "win32";
  const path = target === "win32" ? "package/bin/bun.exe" : "package/bin/bun";
  const archive = await new NativeArchive({ [path]: new Uint8Array([1, 2, 3]) }).bytes();
  const integrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
  let requests = 0;
  const fake: RuntimeFetch = async () => ++requests % 2 ? Response.json({ dist: { tarball: "https://registry.npmjs.org/fixture.tgz", integrity } }) : new Response(archive);
  expect([...await runtimeFor(target, "x64", fake)]).toEqual([1, 2, 3]); expect(requests).toBe(2);
  let error: any;
  try { await runtimeFor(target, "x64", async () => Response.json({ dist: { tarball: "https://other.invalid/runtime", integrity } })); } catch (e) { error = e; }
  expect(error?.message).toContain("registry");
  let calls = 0;
  try { await runtimeFor(target, "x64", async () => ++calls === 1 ? Response.json({ dist: { tarball: "https://registry.npmjs.org/fixture.tgz", integrity } }) : new Response("tampered")); } catch (e) { error = e; }
  expect(error?.message).toContain("integrity mismatch");
});

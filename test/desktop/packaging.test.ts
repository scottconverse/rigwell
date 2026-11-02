// Packaging (spec 14.5, 14.6): the Linux package built by `bun run package:linux` in desktop/ has the Electron fuses flipped,
// carries bun and the daemon sources, and its binary starts and its daemon answers. Skips (printing why) when no package
// has been built or no X server exists. Set RIGWELL_BUILD_PACKAGE=1 to build one first.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand } from "../../desktop/main/daemon-cmd.ts";
import { probeDaemon, readDaemonInfo } from "../../desktop/main/supervisor.ts";
import { sleep } from "./helpers.ts";

setDefaultTimeout(120_000);
const desktop = join(import.meta.dir, "../../desktop");
const unpacked = join(desktop, "release/linux-unpacked");
const exe = join(unpacked, "rigwell");
const fuses = createRequire(import.meta.url)(join(desktop, "packaging/fuses.cjs"));

if (process.env.RIGWELL_BUILD_PACKAGE === "1" && !existsSync(exe)) spawnSync("bun", ["run", "package:linux"], { cwd: desktop, stdio: "inherit" });
const reason = process.platform !== "linux" ? "not Linux" : !existsSync(exe) ? `no Linux package at ${unpacked} (run: cd desktop && bun run package:linux, or set RIGWELL_BUILD_PACKAGE=1)` : "";
if (reason) console.log(`[packaging test skipped: ${reason}]`);
const maybe = reason ? describe.skip : describe;

describe("daemon command", () => {
  test("packaged app uses the bundled bun and daemon sources; env override wins; dev falls back to PATH bun", () => {
    const base = { env: {}, appRoot: "/repo/desktop" };
    expect(daemonCommand({ ...base, packaged: true, resourcesPath: "/opt/R/resources", platform: "linux" })).toEqual(["/opt/R/resources/bun/bun", "/opt/R/resources/daemon/src/cli/main.ts"]);
    expect(daemonCommand({ ...base, packaged: true, resourcesPath: "C:/R/resources", platform: "win32" })[0]).toMatch(/bun\.exe$/);
    expect(daemonCommand({ ...base, env: { RIGWELL_DAEMON_CMD: '["x","y"]' }, packaged: true, resourcesPath: "/r" })).toEqual(["x", "y"]);
    expect(daemonCommand({ ...base, packaged: false })).toEqual(["bun", "/repo/src/cli/main.ts"]);
  });
});

describe("builder config", () => {
  const cfg = readFileOrEmpty(join(desktop, "electron-builder.yml"));
  test("targets: Linux AppImage and deb, macOS dmg and zip, Windows NSIS; fuses hook; bun and daemon bundled", () => {
    for (const t of ["AppImage", "deb", "dmg", "zip", "nsis"]) expect(cfg).toContain(t);
    expect(cfg).toContain("afterPack: packaging/fuses.cjs");
    expect(cfg).toContain("build/stage/bun");
    expect(cfg).toContain("build/stage/daemon");
  });
});

function readFileOrEmpty(p: string) { try { return require("node:fs").readFileSync(p, "utf8") as string; } catch { return ""; } }

maybe("Linux package", () => {
  let xvfb: ChildProcess | undefined, app: ChildProcess | undefined, home = "", display = "";
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), "rigwell-pkg-")); });
  afterAll(async () => {
    try { const d = readDaemonInfo(home); if (d) process.kill(d.pid, "SIGTERM"); } catch {}
    app?.kill("SIGTERM"); await sleep(1500); app?.kill("SIGKILL"); xvfb?.kill();
  });

  test("fuses are set in the built binary: RunAsNode, NODE_OPTIONS, inspect args off; cookie encryption, asar integrity, only-asar on", async () => {
    const got = await fuses.readFuses(exe);
    expect(got).toMatchObject(fuses.EXPECTED);
  });

  test("resources carry the bun runtime, the daemon sources and the asar", () => {
    const res = readdirSync(join(unpacked, "resources"));
    expect(res).toContain("app.asar");
    expect(existsSync(join(unpacked, "resources/bun/bun"))).toBe(true);
    expect(existsSync(join(unpacked, "resources/daemon/src/cli/main.ts"))).toBe(true);
    expect(existsSync(join(unpacked, "resources/daemon/node_modules/quickjs-emscripten"))).toBe(true);
    expect(res).not.toContain("app"); // loaded from the asar only
  });

  test("the packaged binary starts and its bundled daemon answers", async () => {
    display = process.env.DISPLAY || `:${80 + Math.floor(Math.random() * 9)}`;
    if (!process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display };
    delete env.RIGWELL_DAEMON_CMD; delete env.NODE_OPTIONS;
    app = spawn(exe, ["--no-sandbox"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    app.stdout!.on("data", (d) => (log += d)); app.stderr!.on("data", (d) => (log += d));
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      await sleep(300);
      const info = readDaemonInfo(home);
      if (info?.ws?.url) ok = await probeDaemon(info.ws.url);
    }
    if (!ok) console.log(log.replace(/^.*dbus.*\n/gm, "").slice(-2000), readdirSync(home), readFileOrEmpty(join(home, "logs/daemon-stderr.log")));
    expect(ok).toBe(true);
    // The daemon is the bundled bun running the bundled sources.
    const info = readDaemonInfo(home)!;
    const cmdline = readFileOrEmpty(`/proc/${info.pid}/cmdline`).replace(/\0/g, " ");
    expect(cmdline).toContain(join(unpacked, "resources/bun/bun"));
    expect(cmdline).toContain("resources/daemon/src/cli/main.ts");
  });
});

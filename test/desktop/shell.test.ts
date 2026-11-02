// Desktop shell logic that needs no Electron: daemon supervision, appearance before first paint, alerts and sounds.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoot, bootValues, initialWindowOptions, overlayFor, readableOn, resolveTheme } from "../../desktop/main/appearance.ts";
import { badgeCount, notificationFor, soundFor } from "../../desktop/main/alerts.ts";
import { DEFAULT_SETTINGS, loadDesktopSettings, updateDesktopSettings } from "../../desktop/main/settings.ts";
import { DaemonSupervisor, startErrorLine } from "../../desktop/main/supervisor.ts";
import { daemonSocketPath, MAX_SOCKET_PATH_BYTES } from "../../src/daemon/socket-path.ts";
import { AttentionTracker } from "../../src/sidepane/attention.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport, WebSocketTransport } from "../../src/sdk/transport.ts";
import { CLI } from "../e2e/helpers.ts";
import { sleep } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rigwell-desk-"));
/** Opens a WebSocket connection with the token and makes one request (no session needed). */
async function ping(info: { wsUrl: string; token: string }) {
  const rpc = new RpcClient(await WebSocketTransport.connect(info.wsUrl, info.token));
  const r = await rpc.request("list_models");
  await rpc.close();
  return r;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("daemon supervisor (spec 14.1)", () => {
  const sups: DaemonSupervisor[] = [];
  afterEach(async () => { await Promise.all(sups.splice(0).map((s) => s.stop())); });
  const make = (home: string, extra: Partial<ConstructorParameters<typeof DaemonSupervisor>[0]> = {}) => {
    const s = new DaemonSupervisor({ home, command: ["bun", CLI], backoffMs: [100, 200, 400], readyTimeoutMs: 20_000, ...extra });
    sups.push(s);
    return s;
  };

  test("starts a daemon, reaches ready, and a client can connect with the token", async () => {
    const home = tmp();
    const s = make(home);
    const states: string[] = [];
    s.on("state", (x) => states.push(x));
    const info = await s.start();
    expect(s.state).toBe("running");
    expect(states).toEqual(["starting", "running"]);
    expect(info.pid).toBe(s.pid!);
    expect(await ping(info)).toHaveProperty("models");
    await s.stop();
    expect(s.state).toBe("stopped");
    expect(alive(info.pid)).toBe(false);
  }, 30_000);

  test("killing the daemon restarts it; the count resets once it is ready again", async () => {
    const home = tmp();
    const s = make(home);
    const first = await s.start();
    const restarting: any[] = [];
    s.on("restarting", (e) => restarting.push(e));
    const ready = new Promise<any>((r) => s.once("ready", r));
    process.kill(first.pid, "SIGKILL");
    const second = await ready;
    expect(restarting).toEqual([{ attempt: 1, waitMs: 100 }]);
    expect(second.pid).not.toBe(first.pid);
    expect(s.state).toBe("running");
    // The new daemon works (fresh token), and the crash breadcrumb was written.
    expect(await ping(second)).toHaveProperty("models");
    const crash = JSON.parse(readFileSync(join(home, "logs", "daemon-critical-error.json"), "utf8"));
    // Windows has no signals: a killed process reports exit code 1 and no signal name.
    if (process.platform === "win32") { expect(crash.signal).toBeNull(); expect(crash.code).not.toBe(0); } else expect(crash.signal).toBe("SIGKILL");
    // A second kill is attempt 1 again, not 2: the counter reset on ready.
    const again = new Promise<any>((r) => s.once("ready", r));
    process.kill(second.pid, "SIGKILL");
    await again;
    expect(restarting.map((r) => r.attempt)).toEqual([1, 1]);
  }, 40_000);

  test("gives up after three restarts and reports the likely causes", async () => {
    const home = tmp();
    const s = make(home, { command: ["bun", "-e", "process.exit(1)"], backoffMs: [20, 20, 20] });
    const failed = new Promise<Error>((r) => s.once("failed", r));
    const restarts: number[] = [];
    s.on("restarting", (e) => restarts.push(e.attempt));
    await s.start().catch(() => {});
    const err = await failed;
    expect(restarts).toEqual([1, 2, 3]);
    expect(err.message).toContain("antivirus");
    expect(err.message).toContain("firewall");
    expect(s.state).toBe("stopped");
  }, 30_000);

  test("stop() does not restart, and logs rotate at the size limit", async () => {
    const home = tmp();
    mkdtempSync(join(home, "x"));
    const logs = join(home, "logs");
    require("node:fs").mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "daemon-stderr.log"), "x".repeat(5000));
    const s = make(home, { logMaxBytes: 1000 });
    const info = await s.start();
    expect(existsSync(join(logs, "daemon-stderr.log.old"))).toBe(true);
    await s.stop();
    await sleep(400);
    expect(s.state).toBe("stopped");
    expect(alive(info.pid)).toBe(false);
  }, 30_000);

  test("a home path too long for a Unix socket still starts; the socket moves to a short temp path", async () => {
    // Found in a hand walkthrough: a 150-character home made the daemon fail with "Failed to listen".
    const home = join(tmp(), "a".repeat(60), "b".repeat(60));
    expect(join(home, "daemon.sock").length).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    const s = make(home);
    const info = await s.start();
    expect(s.state).toBe("running");
    expect(info.socketPath).toBe(daemonSocketPath(home));
    expect(Buffer.byteLength(info.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    // The Unix socket answers too, not just the WebSocket.
    const rpc = new RpcClient(await SocketTransport.connect(info.socketPath));
    await rpc.close();
    expect(await ping(info)).toHaveProperty("models");
  }, 30_000);

  test("the start error names the cause, not Bun's version line", () => {
    const stderr = "error: Failed to listen at C:\\x\\daemon.sock\n    at startDaemon (src/daemon/daemon.ts:90:22)\r\n\nBun v1.4.4 (Windows x64)\n";
    expect(startErrorLine(stderr)).toBe("error: Failed to listen at C:\\x\\daemon.sock");
    expect(startErrorLine("only a line\n")).toBe("only a line");
    expect(startErrorLine("")).toBe("no output");
  });
});

describe("daemon socket path", () => {
  test("<home>/daemon.sock when it fits; a stable short temp path when it does not", () => {
    expect(daemonSocketPath("/home/u/.rigwell", "/tmp")).toBe(join("/home/u/.rigwell", "daemon.sock"));
    const long1 = join("/home/u", "x".repeat(120)), long2 = join("/home/u", "y".repeat(120));
    const p1 = daemonSocketPath(long1, "/tmp");
    expect(p1).toMatch(/rigwell-[0-9a-f]{16}\.sock$/);
    expect(p1.startsWith(join("/tmp", "rigwell-"))).toBe(true);
    expect(daemonSocketPath(long1, "/tmp")).toBe(p1);
    expect(daemonSocketPath(long2, "/tmp")).not.toBe(p1);
  });
});

describe("appearance before first paint (spec 19.4)", () => {
  const a = DEFAULT_SETTINGS.appearance;
  test("window options use the resolved theme's background and the matching native theme", () => {
    const dark = initialWindowOptions({ ...a, theme: "dark" }, false, "linux");
    expect(dark.backgroundColor).toBe("#161413");
    expect(dark.themeSource).toBe("dark");
    expect(dark.titleBar.titleBarOverlay).toEqual({ color: "#161413", symbolColor: "#f2f2f2", height: 36 });
    const light = initialWindowOptions({ ...a, theme: "light" }, true, "win32");
    expect(light.backgroundColor).toBe("#f2f0f0");
    expect(light.titleBar.titleBarOverlay?.symbolColor).toBe("#1a1a1a");
    // "system" follows the OS at creation time
    expect(initialWindowOptions(a, true, "linux").backgroundColor).toBe("#161413");
    expect(initialWindowOptions(a, false, "linux").backgroundColor).toBe("#f2f0f0");
    // macOS keeps native traffic lights, no overlay
    const mac = initialWindowOptions(a, false, "darwin");
    expect(mac.titleBar.titleBarOverlay).toBeUndefined();
    expect(mac.titleBar.trafficLightPosition).toBeDefined();
  });

  test("custom startup colors and tokens flow into the boot values; bad colors fall back", () => {
    const home = tmp();
    updateDesktopSettings(home, { appearance: { theme: "dark", accent: "#3366ff", startupBackground: { dark: "#101820", light: "nope" }, tokens: { dark: { surface: "#222" } } } });
    const s = loadDesktopSettings(home);
    expect(s.appearance.startupBackground).toEqual({ dark: "#101820", light: "#f2f0f0" });
    const b = bootValues(s.appearance, false);
    expect(b.resolved).toBe("dark");
    expect(b.vars["--rw-accent"]).toBe("#3366ff");
    expect(b.vars["--rw-surface"]).toBe("#222");
    expect(b.bg).toBe("#101820");
  });

  test("the boot script sets the theme from the main process's values with no dependence on stored state", () => {
    const boot = bootValues({ ...a, theme: "dark" }, false);
    const r = applyBoot(boot, "light", false);
    expect(r.attrs["data-theme"]).toBe("dark"); // the main-process value wins over a stale localStorage value
    expect(r.background).toBe("#161413");
    // without the preload values it uses the stored preference, then the OS
    expect(applyBoot(undefined, "light", true).attrs["data-theme"]).toBe("light");
    expect(applyBoot(undefined, null, true).attrs["data-theme"]).toBe("dark");
    expect(applyBoot(undefined, "garbage", false).attrs["data-theme"]).toBe("light");
  });

  test("switching theme at runtime gives matching overlay colors and a theme that resolves the same way", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(overlayFor({ ...a, theme: "light" }, true)).toEqual({ color: "#f2f0f0", symbolColor: "#1a1a1a", height: 36 });
    expect(readableOn("#ffffff")).toBe("#1a1a1a");
    expect(readableOn("#000000")).toBe("#f2f2f2");
  });
});

describe("attention events, notifications and sounds (spec 19)", () => {
  const perm = { toolUses: [{ toolUse: { name: "Execute", id: "t", input: {} }, confirmationType: "exec", details: { fullCommand: "rm -rf build", riskLevel: "medium" } }], options: [] };
  const unfocused = { focused: false };

  test("a permission request becomes an attention event with its own wording", () => {
    const t = new AttentionTracker();
    const ev = t.onRequest("s1", "request_permission", "r1", perm)!;
    expect(ev).toMatchObject({ kind: "attention_requested", requestKind: "permission", category: "questions_and_approvals", sessionId: "s1" });
    expect(ev.summary).toBe("Run a command (medium risk): rm -rf build");
    const done = t.onNotification("s1", { type: "permission_resolved", requestId: "r1" });
    expect(done[0]).toMatchObject({ kind: "attention_resolved", requestId: "r1" });
    expect(t.onRequest("s1", "something_else", "r2", {})).toBeUndefined();
  });

  test("a finished turn uses the first meaningful line of the last assistant message", () => {
    const t = new AttentionTracker();
    t.onNotification("s1", { type: "assistant_text_delta", messageId: "m1", textDelta: "working on it" });
    t.onNotification("s1", { type: "assistant_text_delta", messageId: "m2", textDelta: "\n## \nFixed the typo " });
    t.onNotification("s1", { type: "assistant_text_delta", messageId: "m2", textDelta: "in greet.js.\nMore detail." });
    const [ev] = t.onNotification("s1", { type: "agent_turn_completed", reason: "completed" });
    expect(ev).toMatchObject({ requestKind: "session_completion", category: "agent_turn_complete", summary: "Fixed the typo in greet.js.", failed: false });
    const [c] = t.onNotification("s1", { type: "agent_turn_completed", reason: "cancelled" });
    expect(c.cancelled).toBe(true);
    const [f] = t.onNotification("s1", { type: "agent_turn_completed", reason: "model_rate_limited" });
    expect(f.failed).toBe(true);
    expect(t.onNotification("s1", { type: "session_process_exited", message: "x" })[0].kind).toBe("source_terminated");
  });

  test("notification policy: categories, cancelled, and skipped when the session is on screen", () => {
    const t = new AttentionTracker();
    const need = t.onRequest("s1", "request_permission", "r1", perm)!;
    const fin = t.onNotification("s1", { type: "agent_turn_completed", reason: "completed" })[0];
    const n = notificationFor(need, DEFAULT_SETTINGS, unfocused)!;
    expect(n).toMatchObject({ tag: "session-s1", route: "/sessions/s1", title: "Needs your input" });
    expect(notificationFor(fin, DEFAULT_SETTINGS, unfocused)!.title).toBe("Finished");
    expect(notificationFor(fin, DEFAULT_SETTINGS, { focused: true, viewingSessionId: "s1" })).toBeUndefined();
    expect(notificationFor(fin, DEFAULT_SETTINGS, { focused: true, viewingSessionId: "other" })).toBeDefined();
    expect(notificationFor(need, { ...DEFAULT_SETTINGS, notifications: { finished: true, needsInput: false } }, unfocused)).toBeUndefined();
    expect(notificationFor(fin, { ...DEFAULT_SETTINGS, notifications: { finished: false, needsInput: true } }, unfocused)).toBeUndefined();
    const cancelled = t.onNotification("s1", { type: "agent_turn_completed", reason: "cancelled" })[0];
    expect(notificationFor(cancelled, DEFAULT_SETTINGS, unfocused)).toBeUndefined();
    expect(badgeCount([need, need, { ...need, sessionId: "s2" }, fin])).toBe(2);
  });

  test("sound policy: defaults, volume, focus mode, completion unless cancelled, subagent quiet mode", () => {
    const t = new AttentionTracker();
    const need = t.onRequest("s1", "request_permission", "r1", perm)!;
    const fin = t.onNotification("s1", { type: "agent_turn_completed", reason: "completed" })[0];
    const cancelled = t.onNotification("s1", { type: "agent_turn_completed", reason: "cancelled" })[0];
    const S = DEFAULT_SETTINGS;
    expect(soundFor(need, S, unfocused)).toEqual({ kind: "builtin", id: "ack", volume: 100 }); // awaiting input defaults on
    expect(soundFor(fin, S, unfocused)).toBeUndefined(); // completion defaults off
    const on = { ...S, sounds: { ...S.sounds, completionSound: "bell" as const, soundVolume: 40 } };
    expect(soundFor(fin, on, unfocused)).toEqual({ kind: "bell", volume: 40 });
    expect(soundFor(cancelled, on, unfocused)).toBeUndefined();
    const custom = { ...S, sounds: { ...S.sounds, completionSound: { file: "/x/y.wav" } } };
    expect(soundFor(fin, custom, unfocused)).toEqual({ kind: "file", path: "/x/y.wav", volume: 100 });
    const focusedOnly = { ...S, sounds: { ...S.sounds, soundFocusMode: "focused" as const } };
    expect(soundFor(need, focusedOnly, unfocused)).toBeUndefined();
    expect(soundFor(need, focusedOnly, { focused: true })).toBeDefined();
    const unfocusedOnly = { ...S, sounds: { ...S.sounds, soundFocusMode: "unfocused" as const } };
    expect(soundFor(need, unfocusedOnly, { focused: true })).toBeUndefined();
    expect(soundFor(need, S, unfocused, true)).toBeUndefined(); // subagents silent by default
    expect(soundFor(need, { ...S, sounds: { ...S.sounds, subagentSounds: "quiet" } }, unfocused, true)).toEqual({ kind: "bell", volume: 100 });
  });
});

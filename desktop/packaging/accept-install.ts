// Clean-runner installed acceptance, not a substitute for real macOS hardware.
// Invoke after installing a package in CI. No providers, credentials or user profiles.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { probeDaemon, readDaemonInfo } from "../main/supervisor.ts";

if (process.env.CI !== "true") throw new Error("Installed acceptance runs only on an isolated CI runner");
const executable = resolve(process.argv[2] || ""), output = resolve(process.argv[3] || "installed-acceptance.json");
if (!existsSync(executable)) throw new Error("Provide the installed executable");
const resources = process.platform === "darwin" ? resolve(dirname(executable), "../Resources") : join(dirname(executable), "resources");
const bundledBun = join(resources, "bun", process.platform === "win32" ? "bun.exe" : "bun");
if (!existsSync(bundledBun) || !existsSync(join(resources, "app.asar"))) throw new Error("Installed package is missing bundled resources");
const root = mkdtempSync(join(tmpdir(), "rigwell-installed-")), home = join(root, ".rigwell"); mkdirSync(home);
for (const folder of ["Roaming", "Local"]) mkdirSync(join(root, "AppData", folder), { recursive: true });
writeFileSync(join(home, "settings.json"), "{}");
writeFileSync(join(home, "desktop-settings.json"), JSON.stringify({ desktopAutoUpdateEnabled: false, menuBarEnabled: false }));
const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData/Roaming"), LOCALAPPDATA: join(root, "AppData/Local"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), RIGWELL_HOME: home, RIGWELL_CREDENTIALS: "file" } as Record<string, string>;
for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "RIGWELL_DAEMON_CMD", "RIGWELL_PROFILE", "RIGWELL_PROFILE_ROOT", "RIGWELL_PROFILE_DEFAULT_USER_DATA", "RIGWELL_RENDERER_URL"]) delete env[key];
const socket = createServer(); await new Promise<void>((ok, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", ok); });
const port = (socket.address() as { port: number }).port; await new Promise<void>((ok, fail) => socket.close(error => error ? fail(error) : ok()));
const playwright = createRequire(join(import.meta.dir, "../package.json"))("playwright");
const app = spawn(executable, ["--no-sandbox", "--use-mock-keychain", `--user-data-dir=${join(root, "chromium")}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "", browser: any, observed: ReturnType<typeof readDaemonInfo>;
app.stdout!.on("data", chunk => { log = (log + chunk).slice(-16000); }); app.stderr!.on("data", chunk => { log = (log + chunk).slice(-16000); });
const started = Date.now();
function daemonCommandLine(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  const system = process.env.SystemRoot || "C:\\Windows";
  const result = process.platform === "win32"
    ? spawnSync(join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", windowsHide: true, env: { ...process.env, PSModulePath: join(system, "System32/WindowsPowerShell/v1.0/Modules") } })
    : spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout || "" : "";
}
try {
  let endpoint = "";
  while (Date.now() - started < 60_000) {
    if (app.exitCode !== null) throw new Error(`Installed app exited ${app.exitCode}: ${log}`);
    try { const result = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); endpoint = (await result.json() as any).webSocketDebuggerUrl || ""; } catch {}
    if (endpoint) break; await Bun.sleep(200);
  }
  if (!endpoint) throw new Error(`Installed app did not expose its renderer: ${log}`);
  browser = await playwright.chromium.connectOverCDP(endpoint);
  let page: any;
  for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts().flatMap((context: any) => context.pages()).find((candidate: any) => candidate.url().startsWith("file:")); if (page) break; await Bun.sleep(100); }
  if (!page) throw new Error("Installed app did not create its first-run page");
  await page.getByRole("region", { name: "Connect a model" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Configure a model", exact: true }).waitFor();
  observed = readDaemonInfo(home);
  if (!observed?.ws || !await probeDaemon(observed.ws.url)) throw new Error("Bundled daemon did not answer");
  if (!daemonCommandLine(observed.pid).toLowerCase().includes(bundledBun.toLowerCase())) throw new Error("Daemon is not running the installed bundled runtime");
  const configuration = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  if (configuration.customModels?.length || configuration.models?.length) throw new Error("First run imported unexpected model profiles");
  const receipt = { status: "PASS", platform: process.platform, executable, resources, firstRun: "Connect a model", daemonReady: true, bundledRuntimePresent: true, emptyProfile: true, elapsedMs: Date.now() - started };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt));
} finally {
  if (browser) { try { const cdp = await browser.newBrowserCDPSession(); await cdp.send("Browser.close"); } catch {} }
  for (let attempt = 0; attempt < 30 && app.exitCode === null; attempt++) await Bun.sleep(100);
  if (app.exitCode === null) app.kill();
  // Only stop the recorded daemon when the same profile still names that process
  // and OS command-line evidence identifies this installed runtime.
  const current = readDaemonInfo(home);
  if (!observed && current && Date.parse(current.startedAt) >= started) observed = current;
  if (observed && current?.pid === observed.pid && current.startedAt === observed.startedAt) {
    const command = daemonCommandLine(current.pid);
    if (command?.toLowerCase().includes(bundledBun.toLowerCase())) { try { process.kill(current.pid); } catch {} }
  }
  if (!existsSync(output)) console.error(log);
}

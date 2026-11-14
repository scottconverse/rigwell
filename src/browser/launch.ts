import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { startProxy, type ProxyHandle } from "../sandbox/proxy.ts";
import { CdpConnection, validateCdpUrl } from "../sidepane/browser.ts";
import type { BrowserPolicy } from "./policy.ts";

export function chromeExecutable(override = process.env.RIGWELL_BROWSER_EXECUTABLE): string {
  const paths = override ? [override] : [
    ...["google-chrome", "chromium", "chromium-browser", "chrome", "msedge"].map((n) => Bun.which(n)).filter(Boolean) as string[],
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean).flatMap((p) => [join(p!, "Google/Chrome/Application/chrome.exe"), join(p!, "Microsoft/Edge/Application/msedge.exe")]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  const executable = paths.find((p) => existsSync(p));
  if (!executable) throw new Error("No Chrome or Chromium executable found. Install one or set RIGWELL_BROWSER_EXECUTABLE to its executable path.");
  return executable;
}
export interface HeadlessBrowser { url: string; profile: string; process: ChildProcess; update(policy: BrowserPolicy): void; close(): Promise<void> }
export async function launchHeadlessBrowser(policy: BrowserPolicy, signal: AbortSignal, opts: { executable?: string; log?: (message: string) => void } = {}): Promise<HeadlessBrowser> {
  const executable = chromeExecutable(opts.executable);
  const root = resolve(rigwellHome(), "browser-profiles"); mkdirSync(root, { recursive: true });
  const profile = mkdtempSync(join(root, "owned-"));
  const allowed = [...policy.allowed], denied = [...policy.denied];
  let proxy: ProxyHandle | undefined, child: ChildProcess | undefined, url = "", closed = false;
  let exited: Promise<void> = Promise.resolve(), stderr = "";
  const close = async () => {
    if (closed) return; closed = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (url) {
        let c: CdpConnection | undefined;
        try { c = await CdpConnection.connect(url, 1000); await c.send("Browser.close", {}, undefined, 1000).catch(() => {}); } catch {} finally { c?.close(); }
      }
      await Promise.race([exited, Bun.sleep(1000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, Bun.sleep(2000)]); }
    }
    await proxy?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) throw new Error("Owned browser did not exit; its profile was preserved");
    const target = resolve(profile);
    if (!target.startsWith(root + sep)) throw new Error("Browser profile escaped its owned root");
    try { rmSync(target, { recursive: true, force: true }); } catch { opts.log?.("Browser exited; its locked temporary profile was preserved"); }
  };
  try {
    proxy = await startProxy({ allowed, denied, listen: { port: 0 }, onViolation: (v) => opts.log?.(`[browser] blocked ${v.host}: ${v.reason}`) });
    child = spawn(executable, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${proxy.address}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-quic", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run", "--no-default-browser-check", "about:blank"],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const proc = child;
    exited = new Promise<void>((r) => { proc.once("exit", () => r()); proc.once("error", () => r()); });
    let startError: Error | undefined; proc.once("error", (e) => { startError = e; });
    proc.stderr!.on("data", (d) => { stderr = (stderr + d.toString()).slice(-8000); });
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw new Error("Browser launch cancelled");
      if (startError) throw startError;
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Headless browser exited before CDP was ready: ${stderr.slice(-1000)}`);
      try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
        if (port && path) { url = validateCdpUrl(`ws://127.0.0.1:${port}${path}`); break; }
      } catch { /* Chromium has not published its endpoint yet. */ }
      if (Date.now() - started > 10_000) throw new Error("Headless browser did not publish its CDP endpoint within 10 seconds");
      await Bun.sleep(25);
    }
    opts.log?.(`[browser] owned headless process ${proc.pid} started`);
    return { url, profile, process: proc, update(p) { allowed.splice(0, allowed.length, ...p.allowed); denied.splice(0, denied.length, ...p.denied); }, close };
  } catch (e) { await close(); throw e; }
}

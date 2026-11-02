// Helpers for the desktop-side service tests: an in-process daemon and raw protocol clients (no Electron).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import type { SidePaneOptions } from "../../src/sidepane/index.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { makeHome } from "../e2e/helpers.ts";

export const MODEL = "custom:Fake-Anthropic-0";

export async function startTestDaemon(url: string, sidepane?: SidePaneOptions, ws: false | { port: number } = false) {
  const home = makeHome([{ provider: "anthropic", url, displayName: "Fake Anthropic" }]);
  process.env.RIGWELL_HOME = home;
  const dir = mkdtempSync(join(tmpdir(), "rigwell-desk-sock-"));
  const d = await startDaemon({ socketPath: join(dir, "d.sock"), automations: false, ws, sidepane: sidepane ?? {} });
  return { d, home };
}

export interface TestClient {
  rpc: RpcClient;
  notes: any[];
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  waitFor(pred: (n: any) => boolean, ms?: number): Promise<any>;
  close(): Promise<void>;
}

/** One connection to the daemon. Permission requests are answered with proceed_once. */
export async function connect(socketPath: string): Promise<TestClient> {
  const rpc = new RpcClient(await SocketTransport.connect(socketPath));
  const notes: any[] = [];
  const waiters: { pred: (n: any) => boolean; resolve: (n: any) => void }[] = [];
  rpc.onNotification = (method, params) => {
    if (method !== "session_notification") return;
    const n = params.notification;
    notes.push(n);
    for (const w of [...waiters]) if (w.pred(n)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(n); }
  };
  rpc.onRequest = (method) => {
    if (method === "request_permission") return { selectedOption: "proceed_once" };
    return {};
  };
  return {
    rpc, notes,
    call: (m, p) => rpc.request(m, p),
    waitFor(pred, ms = 15_000) {
      const hit = notes.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for notification")), ms);
        waiters.push({ pred, resolve: (n) => { clearTimeout(t); resolve(n); } });
      });
    },
    close: () => rpc.close(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Playwright comes from desktop/node_modules (devDependency, installed by `npm install` in desktop/) or, in the sandbox, /opt/node-tools. */
const PW_BASES = [join(import.meta.dir, "../../desktop") + "/", "/opt/node-tools/", process.cwd() + "/"];

export function loadPlaywright(): any | null {
  for (const base of PW_BASES) {
    try { return createRequire(base)("playwright"); } catch {}
  }
  return null;
}

/** Playwright plus a reason string ("" when everything needed is present) for tests that need a Chromium. Prints why it skips. */
export function chromiumStatus(label: string): { pw: any | null; reason: string } {
  const pw = loadPlaywright();
  let reason = "";
  if (!pw) reason = `playwright not resolvable from ${PW_BASES.join(", ")} (run npm install in desktop/)`;
  else {
    let exe = "";
    try { exe = pw.chromium.executablePath(); } catch (e) { exe = ""; }
    if (!exe || !existsSync(exe)) reason = `chromium not installed at ${exe || "(unknown)"} (run: npx playwright install chromium, in desktop/)`;
  }
  if (reason) console.log(`[${label} skipped: ${reason}]`);
  return { pw: reason ? null : pw, reason };
}

/** Same for the Electron tests: also needs the Electron binary and an X server. */
export function electronStatus(label: string): { pw: any | null; electronBin: string; reason: string } {
  const electronBin = join(import.meta.dir, "../../desktop/node_modules/electron/dist/electron");
  const pw = loadPlaywright();
  const reason = !pw ? `playwright not resolvable from ${PW_BASES.join(", ")} (run npm install in desktop/)`
    : !existsSync(electronBin) ? `electron binary missing at ${electronBin} (npm install in desktop/ ran with --ignore-scripts? run node node_modules/electron/install.js)`
    : !Bun.which("Xvfb") && !process.env.DISPLAY ? "no X server: neither Xvfb on PATH nor DISPLAY set" : "";
  if (reason) console.log(`[${label} skipped: ${reason}]`);
  return { pw, electronBin, reason };
}

/**
 * What to print when an Electron UI wait times out: visible alerts and banners, the page's text, the daemon's stderr log
 * (it records the trust decision, "[trust] ... is not trusted"), the trust-related environment the app was given and
 * the folders the user settings trust. Never throws.
 */
export async function diagnose(page: any, home: string, extra: Record<string, unknown> = {}): Promise<string> {
  const lines: string[] = [];
  const safe = async (label: string, fn: () => unknown) => { try { lines.push(`${label}: ${JSON.stringify(await fn())}`); } catch (e) { lines.push(`${label}: unavailable (${(e as Error).message})`); } };
  await safe("url", () => page.url());
  await safe("alerts", () => page.locator("[role=alert], [role=alertdialog], [role=dialog], .banner").allTextContents());
  await safe("body", async () => ((await page.locator("body").innerText()) as string).slice(0, 600));
  await safe("daemon stderr tail", () => readFileSync(join(home, "logs", "daemon-stderr.log"), "utf8").slice(-1500));
  await safe("trustedFolders", () => Object.keys(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders ?? {}));
  await safe("test process RIGWELL_TRUST_CWD", () => process.env.RIGWELL_TRUST_CWD);
  for (const [k, v] of Object.entries(extra)) await safe(k, () => v);
  return lines.join("\n");
}

/** Runs `fn`; when it throws, prints `diagnose(...)` before rethrowing, so a CI log shows why. */
export async function withDiagnosis<T>(page: any, home: string, extra: () => Record<string, unknown> | Promise<Record<string, unknown>>, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { console.log(`[ui wait failed: ${(e as Error).message.split("\n")[0]}]\n${await diagnose(page, home, await extra())}`); throw e; }
}

import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowserManager } from "../../src/browser/tools.ts";
import type { ToolContext } from "../../src/core/types.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { chromiumStatus } from "./helpers.ts";
import { spawn } from "node:child_process";
import { CLI, lastToolResult } from "../e2e/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
const { pw, reason } = chromiumStatus("standalone agent browser acceptance");
const PAGE = `<!doctype html><title>Fixture browser</title><h1>Task form</h1>
<form onsubmit="event.preventDefault();document.getElementById('result').textContent='Saved '+document.querySelector('input').value"><input aria-label="Task"><button>Save</button></form><p id=result>Waiting</p>
<button onclick="setTimeout(()=>document.getElementById('later').textContent='Later ready',80)">Later</button><p id=later></p>
<input type=file aria-label="Upload fixture" oncancel="document.getElementById('upload-result').textContent='Upload canceled'"><p id=upload-result></p><a href=/download download>Download fixture</a><div style="height:2000px">Long page</div>`;
const ref = (snapshot: string, role: string, name: string) => {
  const line = snapshot.split("\n").find((l) => l.includes(`${role} ${JSON.stringify(name)}`));
  const match = line && /\[(\d+)\]/.exec(line); if (!match) throw new Error(`Missing ${role} ${name}: ${snapshot}`); return Number(match[1]);
};

(reason ? test.skip : test)("one-shot CLI exposes browser tools, refuses unapproved evaluation and closes its owned browser", async () => {
  const env = tmpEnv(); let trapHits = 0;
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { if (new URL(req.url).pathname === "/trap") trapHits++; return new Response(PAGE, { headers: { "content-type": "text/html" } }); } });
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "browser_open", input: { url: `http://127.0.0.1:${web.port}` } }] },
    (body) => { if (!lastToolResult(body).includes("Task form")) throw new Error("Browser snapshot did not reach the agent"); return { toolCalls: [{ name: "browser_evaluate", input: { expression: `fetch('http://127.0.0.1:${web.port}/trap')` } }] }; },
  ]);
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ model: "fake-browser", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-key" }] });
  const child = spawn(process.execPath, [CLI, "exec", "--auto", "high", "--model", "custom:Fixture-0", "--cwd", env.root, "Inspect the fixture"], { windowsHide: true, env: { ...process.env, RIGWELL_BROWSER_TRACE: "1", RIGWELL_BROWSER_EXECUTABLE: pw.chromium.executablePath() }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => errors += data);
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  const diagnostic = setTimeout(() => console.error("[browser CLI pending]", JSON.stringify({ requests: fake.requests.length, errors, output })), 8000);
  try {
    const code = await exited;
    expect({ code, errors }).toMatchObject({ code: 1 }); expect(errors).toContain("no_approver_available"); expect(fake.requests.length).toBe(2); expect(trapHits).toBe(0);
    expect(readdirSync(join(env.rigwellHome, "browser-profiles"))).toEqual([]);
  } finally { clearTimeout(diagnostic); if (child.exitCode === null) { child.kill(); await exited; } fake.stop(); web.stop(true); env.cleanup(); }
}, 15_000);
(reason ? test.skip : test)("standalone named tools drive real headless Chromium, accessibility refs, downloads and owned cleanup", async () => {
  const env = tmpEnv();
  const previousTrace = process.env.RIGWELL_BROWSER_TRACE; process.env.RIGWELL_BROWSER_TRACE = "1";
  const trace: string[] = []; let phase = "opening";
  const diagnostic = setTimeout(() => console.error("[standalone browser pending]", JSON.stringify({ phase, trace })), 8000);
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/download" ? new Response("fixture-download", { headers: { "content-disposition": 'attachment; filename="fixture.txt"' } }) : new Response(PAGE, { headers: { "content-type": "text/html" } }); } });
  const manager = new AgentBrowserManager(undefined, { executable: pw.chromium.executablePath(), log: (message) => { trace.push(message); if (trace.length > 100) trace.shift(); } });
  const ctx: ToolContext = { cwd: env.root, sessionId: "browser-fixture", readFiles: new Map(), signal: new AbortController().signal, imagesSupported: false };
  const run = async (name: string, input: Record<string, unknown> = {}) => { phase = name; const r = await manager.run(name, input, ctx); if (r.isError) throw new Error(r.content); return r; };
  try {
    let r = await run("browser_open", { url: `http://127.0.0.1:${web.port}` }); expect(r.content).toContain("Accessibility tree:"); expect(r.content).toContain('heading "Task form"');
    r = await run("browser_type", { ref: ref(r.content, "textbox", "Task"), text: "first value" }); expect(r.content).toContain('value="first value"');
    r = await run("browser_type", { ref: ref(r.content, "textbox", "Task"), text: "second value" }); expect(r.content).not.toContain("first value");
    r = await run("browser_press", { key: "Enter" }); expect(r.content).toContain("Saved second value");
    r = await run("browser_click", { ref: ref(r.content, "button", "Later") });
    expect((await run("browser_wait", { text: "Later ready" })).content).toContain("Later ready");
    await run("browser_scroll", { deltaY: 450 });
    const shot = await run("browser_screenshot"); const path = (shot.data as any).path;
    expect(existsSync(path)).toBe(true); expect(readFileSync(path).subarray(1, 4).toString()).toBe("PNG"); expect(shot.images).toBeUndefined();
    r = await run("browser_snapshot"); await run("browser_click", { ref: ref(r.content, "link", "Download fixture") });
    const directory = join(env.root, ".rigwell/browser/browser-fixture");
    const started = Date.now(); let downloaded = false;
    while (Date.now() - started < 2000) { downloaded = readdirSync(directory).some((p) => !p.endsWith(".png") && !p.endsWith(".crdownload") && readFileSync(join(directory, p), "utf8") === "fixture-download"); if (downloaded) break; await Bun.sleep(20); }
    expect(downloaded).toBe(true);
    r = await run("browser_snapshot"); await run("browser_click", { ref: ref(r.content, "button", "Upload fixture") });
    expect((await run("browser_wait", { text: "Upload canceled", timeoutMs: 2000 })).content).toContain("Upload canceled");
    expect((await run("browser_evaluate", { expression: "document.title" })).content).toBe('"Fixture browser"');
    expect((await manager.run("browser_click", { ref: 99999 }, ctx)).content).toContain("Unknown element ref");
    await run("browser_close"); expect(readdirSync(join(env.rigwellHome, "browser-profiles"))).toEqual([]);
  } finally { clearTimeout(diagnostic); await manager.closeAll(); web.stop(true); env.cleanup(); if (previousTrace === undefined) delete process.env.RIGWELL_BROWSER_TRACE; else process.env.RIGWELL_BROWSER_TRACE = previousTrace; }
}, 15_000);

(reason ? test.skip : test)("closing a session cancels an active browser wait and releases its owned profile", async () => {
  const env = tmpEnv(), manager = new AgentBrowserManager(undefined, { executable: pw.chromium.executablePath() });
  const ctx: ToolContext = { cwd: env.root, sessionId: "browser-cancel", readFiles: new Map(), signal: new AbortController().signal };
  try {
    const opened = await manager.run("browser_open", { url: "about:blank" }, ctx); expect(opened.isError).not.toBe(true);
    const waiting = manager.run("browser_wait", { text: "This never appears", timeoutMs: 30000 }, ctx);
    await Bun.sleep(50); const started = Date.now(); await manager.closeSession(ctx.sessionId);
    expect((await waiting).content).toContain("cancelled"); expect(Date.now() - started).toBeLessThan(2000);
    expect(readdirSync(join(env.rigwellHome, "browser-profiles"))).toEqual([]);
  } finally { await manager.closeAll(); env.cleanup(); }
}, 10_000);

(reason ? test.skip : test)("browser policy blocks redirects, subresources and WebSockets before they reach a denied fake host", async () => {
  const env = tmpEnv(); let trapHits = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { trapHits++; return new Response("Denied fixture"); } });
  const denied = `http://localhost:${trap.port}`;
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/redirect") return Response.redirect(denied, 302);
    return new Response(`<title>Policy fixture</title><h1>Allowed fixture</h1><p id=result>Waiting</p><img src="${denied}/image"><iframe src="${denied}/frame"></iframe><script>
      Promise.all([fetch('${denied}/fetch').catch(()=>{}),new Promise(r=>{const w=new WebSocket('ws://localhost:${trap.port}/socket');w.onerror=()=>r();w.onopen=()=>r();})]).then(()=>document.getElementById('result').textContent='Network probes finished');
    </script>`, { headers: { "content-type": "text/html" } });
  } });
  const manager = new AgentBrowserManager(undefined, { executable: pw.chromium.executablePath() });
  const ctx: ToolContext = { cwd: env.root, sessionId: "browser-policy", readFiles: new Map(), signal: new AbortController().signal };
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { sandbox: { network: { allowedDomains: ["127.0.0.1"], deniedDomains: ["localhost"] } } });
    const opened = await manager.run("browser_open", { url: `http://127.0.0.1:${web.port}` }, ctx); expect(opened.isError).not.toBe(true);
    const waited = await manager.run("browser_wait", { text: "Network probes finished", timeoutMs: 2000 }, ctx); expect(waited.isError).not.toBe(true);
    expect(trapHits).toBe(0);
    const redirect = await manager.run("browser_open", { url: `http://127.0.0.1:${web.port}/redirect` }, ctx); expect(redirect.isError).toBe(true); expect(trapHits).toBe(0);
    const file = await manager.run("browser_open", { url: new URL(`file:///${env.rigwellHome.replaceAll("\\", "/")}/credentials.json`).href }, ctx); expect(file.isError).toBe(true); expect(file.content).toContain("HTTP or HTTPS");
  } finally { await manager.closeAll(); web.stop(true); trap.stop(true); env.cleanup(); }
}, 10_000);

(reason ? test.skip : test)("browser screenshots and downloads honor a denied output directory", async () => {
  const env = tmpEnv(), manager = new AgentBrowserManager(undefined, { executable: pw.chromium.executablePath() });
  const ctx: ToolContext = { cwd: env.root, sessionId: "browser-files", readFiles: new Map(), signal: new AbortController().signal };
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/download" ? new Response("Must not be written", { headers: { "content-disposition": 'attachment; filename="blocked.txt"' } }) : new Response('<title>Downloads</title><a href="/download" download>Download fixture</a>', { headers: { "content-type": "text/html" } }); } });
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { sandbox: { filesystem: { denyWrite: [join(env.root, ".rigwell")] } } });
    const opened = await manager.run("browser_open", { url: `http://127.0.0.1:${web.port}` }, ctx); expect(opened.isError).not.toBe(true);
    const shot = await manager.run("browser_screenshot", {}, ctx); expect(shot.isError).toBe(true); expect(shot.content).toContain("blocked by the file policy");
    const clicked = await manager.run("browser_click", { ref: ref(opened.content, "link", "Download fixture") }, ctx); expect(clicked.isError).not.toBe(true);
    await Bun.sleep(100); expect(existsSync(join(env.root, ".rigwell/browser/browser-files"))).toBe(false);
  } finally { await manager.closeAll(); web.stop(true); env.cleanup(); }
}, 10_000);

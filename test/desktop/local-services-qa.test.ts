import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localService } from "../../src/automations/local-services.ts";
import { createAutomationService } from "../../src/automations/index.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { makeRepo, lastToolResult } from "../e2e/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { chromiumStatus } from "./helpers.ts";
import { FakeClock } from "../automations/helpers.ts";

const { pw, reason } = chromiumStatus("local QA service acceptance");
const ref = (snapshot: string, role: string, name: string) => {
  const line = snapshot.split("\n").find((s) => s.includes(`${role} ${JSON.stringify(name)}`));
  if (!line) throw new Error(`Missing ${role} ${name}: ${snapshot}`);
  return Number(/\[(\d+)\]/.exec(line)![1]);
};

(reason ? test.skip : test)("installed QA starts its dev server, tests changed flows in headless Chromium and releases server/browser on session close", async () => {
  const env = tmpEnv(), repo = makeRepo(), clock = new FakeClock(Date.now()), previous = process.env.RIGWELL_BROWSER_EXECUTABLE;
  process.env.RIGWELL_BROWSER_EXECUTABLE = pw.chromium.executablePath();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const ready = join(repo, "ready.json");
  // Test-only dev server and bounded readiness check, both run by the actual agent Execute tool.
  const page = `<title>QA fixture</title><h1>Changed form</h1><form onsubmit="event.preventDefault();document.getElementById('result').textContent='Saved '+document.querySelector('input').value"><label>Task<input></label><button>Save</button></form><p id="result">Waiting</p>`;
  writeFileSync(join(repo, "dev.cjs"), `const http=require('node:http'),fs=require('node:fs');const server=http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(${JSON.stringify(page)})});server.listen(0,'127.0.0.1',()=>fs.writeFileSync('ready.json',JSON.stringify({port:server.address().port,pid:process.pid})));`);
  writeFileSync(join(repo, "ready.cjs"), `const fs=require('node:fs');const start=Date.now();const timer=setInterval(()=>{if(fs.existsSync('ready.json')){console.log('server-ready');clearInterval(timer)}else if(Date.now()-start>2000){clearInterval(timer);process.exitCode=1}},20);`);
  let port = 0;
  const fake = await startFakeAnthropic([
    (body) => { expect(JSON.stringify(body)).toContain(head); return { toolCalls: [{ name: "Skill", input: { name: "agent-browser" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("accessibility tree"); return { toolCalls: [{ name: "Execute", input: { command: "git rev-parse HEAD", riskLevel: "low", riskReason: "Verify the local QA checkout" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain(head); return { toolCalls: [{ name: "Execute", input: { command: "node dev.cjs", background: true, riskLevel: "medium", riskReason: "Start the approved fixture dev server" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("job_id"); return { toolCalls: [{ name: "Execute", input: { command: "node ready.cjs", riskLevel: "low", riskReason: "Wait for the owned server readiness file" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("server-ready"); port = JSON.parse(readFileSync(ready, "utf8")).port; return { toolCalls: [{ name: "browser_open", input: { url: `http://127.0.0.1:${port}` } }] }; },
    (body) => ({ toolCalls: [{ name: "browser_type", input: { ref: ref(lastToolResult(body), "textbox", "Task"), text: "QA change" } }] }),
    (body) => ({ toolCalls: [{ name: "browser_click", input: { ref: ref(lastToolResult(body), "button", "Save") } }] }),
    (body) => { expect(lastToolResult(body)).toContain("Saved QA change"); return { toolCalls: [{ name: "browser_wait", input: { text: "Saved QA change", timeoutMs: 1000 } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("Saved QA change"); return { text: "QA PASS: observed Saved QA change after submitting the changed form. Other flows not checked." }; },
  ]);
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake", baseUrl: fake.url }] });
  const svc = createAutomationService({ clock, retryBaseDelayMs: 1 });
  try {
    const b = localService({ service: "qa", repo: "fixture/project", transport: "webhook", devCommand: "node dev.cjs", url: "http://127.0.0.1:4321", flows: "Enter a task and save" }, repo);
    const a = svc.manager.create(b.fm, b.instructions, b.project);
    clock.advance(1000);
    svc.triggers.enqueue(a, { id: "qa-fixture", kind: "pr_updated", at: clock.now(), payload: { repo: "fixture/project", number: 1, head: { sha: head } } });
    await svc.triggers.tick(); await svc.manager.idle();
    const history = svc.manager.history(a.id); expect(history[0]!.status).toBe("success"); expect(fake.requests).toHaveLength(9);
    const report = readdirSync(join(a.dir, "reports")).find((p) => p.endsWith(".md"))!;
    expect(readFileSync(join(a.dir, "reports", report), "utf8")).toContain("QA PASS");
    expect(port).toBeGreaterThan(0);
    expect(await fetch(`http://127.0.0.1:${port}`).then(() => false, () => true)).toBe(true);
    expect(existsSync(join(env.rigwellHome, "browser-profiles"))).toBe(true);
    expect(readdirSync(join(env.rigwellHome, "browser-profiles"))).toEqual([]);
  } finally {
    svc.stop(); await svc.manager.idle(); fake.stop();
    if (previous === undefined) delete process.env.RIGWELL_BROWSER_EXECUTABLE; else process.env.RIGWELL_BROWSER_EXECUTABLE = previous;
    rmSync(repo, { recursive: true, force: true }); env.cleanup();
  }
}, 15_000);

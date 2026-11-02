// Browser pane: the agent drives a real (headless) Chromium through the Browser tool, over CDP, via the daemon.
// Headless Chromium stands in for the app's webview; the app exposes the same kind of endpoint (spec 17.3).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { lastToolResult, makeRepo } from "../e2e/helpers.ts";
import { validateCdpUrl } from "../../src/sidepane/browser.ts";
import { chromiumStatus, connect, MODEL, startTestDaemon } from "./helpers.ts";

const { pw } = chromiumStatus("browser pane test");
const maybe = pw ? describe : describe.skip;

describe("CDP endpoint validation (spec 17.3)", () => {
  const ok = "ws://127.0.0.1:41000/devtools/browser/abc-123";
  test("accepts only the loopback browser endpoint on the expected port", () => {
    expect(validateCdpUrl(ok, 41000)).toBe(ok);
    for (const bad of [
      "wss://127.0.0.1:41000/devtools/browser/abc", "ws://localhost:41000/devtools/browser/abc", "ws://127.0.0.1:41001/devtools/browser/abc",
      "ws://u:p@127.0.0.1:41000/devtools/browser/abc", "ws://127.0.0.1:41000/devtools/browser/abc#x", "ws://127.0.0.1:41000/devtools/page/abc",
      "ws://127.0.0.1:41000/devtools/browser/../x", "ws://127.0.0.1:41000/devtools/browser/abc?x=1", "http://127.0.0.1:41000/devtools/browser/abc", 5,
    ]) expect(() => validateCdpUrl(bad, 41000)).toThrow();
  });
});

const PAGE = `<!doctype html><title>Tasks</title><body>
<h1>Task list</h1><input id=t placeholder="New task"><button id=add onclick="
 const li=document.createElement('li'); li.textContent=document.getElementById('t').value; document.getElementById('l').appendChild(li); document.getElementById('t').value='';">Add task</button>
<ul id=l></ul><a href="/about">About page</a></body>`;

maybe("Browser tool, agent path", () => {
  let browser: any, page: any, web: ReturnType<typeof Bun.serve>, fake: FakeServer, cdpUrl: string, cdpPort: number;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  const seenTools: string[][] = [];
  const results: string[] = [];

  /** The ref of the first element whose line matches. */
  const refOf = (text: string, re: RegExp) => {
    const line = text.split("\n").find((l) => re.test(l));
    if (!line) throw new Error(`no element matching ${re} in:\n${text}`);
    return Number(/^\[(\d+)\]/.exec(line)![1]);
  };

  beforeAll(async () => {
    web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(new URL(r.url).pathname === "/about" ? "<title>About</title><p>About us</p>" : PAGE, { headers: { "content-type": "text/html" } }) });
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    cdpPort = probe.port as number;
    probe.stop(true);
    browser = await pw.chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
    page = await (await browser.newContext()).newPage();
    cdpUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() as any).webSocketDebuggerUrl;

    const script: FakeTurn[] = [
      (body) => { seenTools.push(body.tools.map((t: any) => t.name)); return { toolCalls: [{ name: "Browser", input: { action: "navigate", url: `http://127.0.0.1:${web.port}/` } }] }; },
      (body) => {
        const r = lastToolResult(body); results.push(r);
        return { toolCalls: [{ name: "Browser", input: { action: "type", ref: refOf(r, /input.*New task/), text: "write tests" } }] };
      },
      (body) => {
        const r = lastToolResult(body); results.push(r);
        return { toolCalls: [{ name: "Browser", input: { action: "click", ref: refOf(r, /button "Add task"/) } }] };
      },
      (body) => {
        results.push(lastToolResult(body));
        return { toolCalls: [{ name: "Browser", input: { action: "evaluate", expression: "document.querySelector('#l').innerText" } }] };
      },
      (body) => { results.push(lastToolResult(body)); return { toolCalls: [{ name: "Browser", input: { action: "screenshot" } }] }; },
      (body) => { results.push(lastToolResult(body)); return { text: "done driving the browser" }; },
    ];
    fake = await startFakeAnthropic(script);
    daemon = await startTestDaemon(fake.url, { browserPort: cdpPort });
  });
  afterAll(async () => {
    daemon?.d.stop(); fake?.stop(); await browser?.close(); web?.stop(true);
  });

  test("the agent navigates, types, clicks and reads the page; the page really changed", async () => {
    const repo = makeRepo();
    const c = await connect(daemon.d.socketPath);
    await c.call("initialize_session", { cwd: repo, modelId: MODEL, autonomyLevel: "low" });
    // The app attaches the pane's CDP endpoint; a foreign endpoint is refused.
    const refused: any = await c.call("daemon.browser_attach", { cdpUrl: `ws://127.0.0.1:${cdpPort + 1}/devtools/browser/x` }).catch((e) => e);
    expect(refused.code).toBe(-32602);
    expect(await c.call("daemon.browser_attach", { cdpUrl })).toEqual({ attached: true });
    await c.call("add_user_message", { text: "add a task called write tests in the browser" });
    const done = await c.waitFor((n) => n.type === "agent_turn_completed");
    expect(done.reason).toBe("completed");

    expect(seenTools[0]).toContain("Browser");
    expect(results[0]).toContain("Task list");
    expect(results[0]).toMatch(/\[\d+\] button "Add task"/);
    expect(results[0]).toContain("-> /about");
    expect(results[1]).toMatch(/input:text "New task" value="write tests"/);
    expect(results[2]).toContain("write tests"); // visible text after the click
    expect(results[3]).toBe('"write tests"');
    expect(results[4]).toMatch(/Saved screenshot to (\S+\.png)/);
    expect(existsSync(/to (\S+\.png)/.exec(results[4])![1])).toBe(true);

    // Independent check through Playwright: the DOM the agent changed is the DOM in the browser.
    const pages = browser.contexts().flatMap((x: any) => x.pages());
    const texts = await Promise.all(pages.map((p: any) => p.locator("#l").innerText().catch(() => "")));
    expect(texts.some((t: string) => t.includes("write tests"))).toBe(true);
    await c.close();
  }, 60_000);

  test("without an attached pane the tool explains instead of failing the turn", async () => {
    const f2 = await startFakeAnthropic([
      { toolCalls: [{ name: "Browser", input: { action: "tabs" } }] },
      (body) => ({ text: lastToolResult(body) }),
    ]);
    const d2 = await startTestDaemon(f2.url, {});
    const c = await connect(d2.d.socketPath);
    await c.call("initialize_session", { cwd: makeRepo(), modelId: MODEL, autonomyLevel: "low" });
    await c.call("add_user_message", { text: "list tabs" });
    const done = await c.waitFor((n) => n.type === "agent_turn_completed");
    expect(done.reason).toBe("completed");
    const text = c.notes.filter((n) => n.type === "assistant_text_delta").map((n) => n.textDelta).join("");
    expect(text).toContain("browser pane is not open");
    await c.close(); d2.d.stop(); f2.stop();
  });
});

import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { until } from "../workstreams/helpers.ts";
const { pw, reason } = chromiumStatus("Inbox headless acceptance");
(reason ? test.skip : test)("production Inbox filters real engine events, persists read state, opens its source and confirms SMTP settings", async () => {
  const env = tmpEnv(), sent: any[] = [], fake = await startFakeAnthropic([
    { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Inbox", question: "Inbox fixture question?", options: ["Yes"] }] } }] },
    { text: "Inbox source answer" }, { text: "Automation fixture done" },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: RpcClient | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  const prompts: any[] = [];
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fixture-key", baseUrl: fake.url }] });
    daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, sidepane: false, automations: { webhookPort: 0 }, delegation: false, ws: { port: 0 }, inbox: { send: async (_c, m) => { sent.push(m); } } });
    client = new RpcClient(await SocketTransport.connect(daemon.socketPath)); client.onRequest = async (_m, p) => { prompts.push(p); return new Promise(() => {}); };
    const initialized = await client.request("initialize_session", { cwd: env.root, title: "Inbox source", autonomyLevel: "off" });
    await client.request("add_user_message", { text: "Ask a question" }); await until(() => prompts.length === 1);
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    const url = `http://127.0.0.1:${web.port}/inbox`; await page.goto(url);
    const row = page.getByRole("list", { name: "Inbox items", exact: true }).getByRole("listitem").filter({ hasText: "Inbox fixture question?" });
    await row.getByText("Needs your answer", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Mark read", exact: true }).click(); expect(daemon.inbox.store.list().unread).toBe(0);
    await page.reload(); await row.getByRole("button", { name: "Mark unread", exact: true }).click(); expect(daemon.inbox.store.list().unread).toBe(1);
    await page.getByLabel("Inbox category", { exact: true }).selectOption("turn"); await page.getByText("No Inbox items in this view.", { exact: true }).waitFor();
    await page.getByLabel("Inbox category", { exact: true }).selectOption("question"); await row.getByRole("button", { name: "Open source", exact: true }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).waitFor();
    await client.request("answer_request", { requestId: prompts[0].requestId, answer: { answers: [{ index: 0, question: "Inbox fixture question?", answer: "Yes" }] } });
    await page.getByText("Inbox source answer", { exact: true }).waitFor();
    const auto = daemon.automations!.manager.create({ name: "Inbox automation", trigger: "webhook", workingDirectory: env.root }, "Finish");
    await daemon.automations!.manager.run(auto.id).done;
    await client.request("enter_mission_mode", { continue: true }); await client.request("mission_pause", {});
    const entries = daemon.inbox.store.list().items;
    expect(new Set(entries.map((i) => i.category))).toEqual(new Set(["question", "turn", "automation", "mission"]));
    expect(entries.find((i) => i.requestId === prompts[0].requestId)?.resolved).toBe(true);
    expect(entries.find((i) => i.category === "turn")?.sessionId).toBe(initialized.sessionId);
    await page.goto(url); await page.getByRole("button", { name: "Email alerts", exact: true }).click();
    await page.getByLabel("Enable email alerts", { exact: true }).check(); await page.getByLabel("SMTP hostname", { exact: true }).fill("smtp.example.test");
    await page.getByLabel("SMTP username", { exact: true }).fill("fixture"); await page.getByLabel("SMTP password secret name", { exact: true }).fill("smtp");
    await page.getByLabel("Sender address", { exact: true }).fill("rigwell@example.test"); await page.getByLabel("Recipient address", { exact: true }).fill("owner@example.test");
    await page.getByLabel("turn email frequency", { exact: true }).selectOption("immediate");
    await page.getByRole("button", { name: "Save email alerts", exact: true }).click(); await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(daemon.inbox.methods.get_email_alerts().config.enabled).toBe(false);
    await page.getByRole("button", { name: "Save email alerts", exact: true }).click(); await page.getByRole("button", { name: "Save email delivery", exact: true }).click();
    await until(() => daemon!.inbox.methods.get_email_alerts().config.enabled); expect(sent).toHaveLength(0); expect(errors).toEqual([]);
  } catch (e) { console.error("[Inbox UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page", daemon?.inbox.store.list()); throw e; }
  finally { await browser?.close(); web?.stop(true); await client?.close(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);

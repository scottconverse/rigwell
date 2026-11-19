import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus, startTestDaemon } from "./helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { tmp } from "../worktree/util.ts";
import { until } from "../workstreams/helpers.ts";
import { listWorkstreamStores } from "../../src/workstreams/store.ts";
import { DaemonBroker } from "../../desktop/main/broker.ts";

const { pw, reason } = chromiumStatus("Workstreams headless UI");
const uiTest = reason ? test.skip : test;
type Daemon = Awaited<ReturnType<typeof startTestDaemon>>["d"];

async function openWorkstreamFixture(daemon: Daemon, cwd: string, workstreamId?: string) {
  const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/workstreams.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureUrl=${JSON.stringify(`${daemon.wsUrl}?token=${daemon.wsToken}`)};window.fixtureId=${JSON.stringify(workstreamId ?? "")};window.fixtureCwd=${JSON.stringify(cwd)}</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }) });
  let browser: any;
  const close = async () => { try { await browser?.close(); } finally { server.stop(true); } };
  try {
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "domcontentloaded" });
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
uiTest("desktop workstream uses real protocol for messages, prompts, pause, archive and live transcripts", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 40 }, () => (body: any) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("REACH TOKEN CAP")) return { text: "Cap reached", usage: { input: 3_000_000, output: 1 } };
    return last.includes("QUESTION") ? { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Choice", question: "Which direction?", options: ["North", "South"] }] } }] } : { text: "Member finished" };
  }));
  const { d } = await startTestDaemon(fake.url, undefined, { port: 0 });
  const service = d.workstreams, cwd = tmp("ws-ui");
  const lead = new MemberSession({ tools: (tools) => attached.wrapTools(tools), notify() {}, request: async () => ({ selectedOption: "proceed_once" }) });
  const attached = service.attach({ session: () => lead.connection.session, notify() {}, request: async (_m, p) => p.toolUses ? { selectedOption: "proceed_once" } : new Promise(() => {}) });
  let fixture: Awaited<ReturnType<typeof openWorkstreamFixture>> | undefined;
  const attention: any[] = [], traffic: any[] = [];
  const broker = new DaemonBroker(() => ({ wsUrl: d.wsUrl!, token: d.wsToken! }), { deliver: (_w, _channel, payload) => traffic.push(payload), onAttention: (ev) => attention.push(ev) });
  try {
    await lead.call("initialize_session", { cwd, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "low" });
    const accepted = await service.propose({ session: () => lead.connection.session, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) }, { title: "UI coordination", goal: "Ship a local change", plan: "Work together", budget: { maxTokens: 3_000_000 } });
    const agent = await service.spawn(lead.connection.session!, { name: "Builder", role: "Implement", prompt: "INITIAL", worktree: false });
    const member = service.members.get(agent.agentId)!; await member.connection.session!.idle();
    const control = await broker.openConnection(19);
    broker.send(19, control, JSON.stringify({ jsonrpc: "2.0", type: "request", id: "watch", method: "rigwell.list_workstreams", params: {} }));
    await until(() => traffic.some((p) => p.message && JSON.parse(p.message).id === "watch"));
    fixture = await openWorkstreamFixture(d, cwd, accepted.workstreamId);
    const { page } = fixture;
    const budgetRequests: any[] = [], budgetReplies = new Map<string, any>();
    page.on("websocket", (ws: { on(event: string, callback: (frame: { payload: string | Buffer }) => void): void }) => {
      ws.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.method === "rigwell.resume_workstream") budgetRequests.push(message);
      });
      ws.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (budgetRequests.some((request) => message.id === request.id)) budgetReplies.set(message.id, message);
      });
    });
    await page.getByRole("button").filter({ hasText: "UI coordination" }).click();
    await page.getByRole("heading", { name: "UI coordination", exact: true }).waitFor();
    expect(await page.getByLabel("Agents", { exact: true }).innerText()).toContain("Builder");
    await page.getByRole("button", { name: "Message", exact: true }).click();
    const messageDialog = page.getByRole("dialog", { name: "Message Builder" });
    await messageDialog.getByLabel("Message", { exact: true }).fill("USER TIMELINE");
    await messageDialog.getByLabel("Delivery priority").selectOption("later");
    await messageDialog.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByLabel("Message timeline").getByText("USER TIMELINE", { exact: true }).waitFor();
    expect(JSON.stringify(fake.requests)).toContain("USER TIMELINE");
    await member.call("add_user_message", { text: "QUESTION" });
    const prompts = page.getByLabel("Member prompts"); await prompts.getByText("[Choice] Which direction?", { exact: true }).waitFor();
    expect(await prompts.innerText()).toContain("Builder");
    expect(attention.filter((e) => e.category === "workstream_needs_input" && e.kind === "attention_requested")).toHaveLength(1);
    await prompts.getByRole("button", { name: "North", exact: true }).click();
    await member.connection.session!.idle(); await until(() => !member.connection.session!.pendingPrompts().length);
    await page.getByRole("button", { name: "Open transcript", exact: true }).click();
    await page.getByRole("heading", { name: "Live transcript" }).waitFor();
    expect(await page.locator("pre").innerText()).toContain("USER TIMELINE");
    await member.call("add_user_message", { text: "LIVE VIEW UPDATE" }); await member.connection.session!.idle();
    await page.locator("pre").filter({ hasText: "LIVE VIEW UPDATE" }).waitFor();
    await page.getByRole("button", { name: "Back to workstream" }).click();
    await member.call("add_user_message", { text: "REACH TOKEN CAP" }); await member.connection.session!.idle();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const budgetDialog = page.getByRole("dialog", { name: "Resume workstream" });
    const tokenLimit = budgetDialog.getByLabel("Token limit", { exact: true });
    expect(await tokenLimit.inputValue()).toBe("3000000");
    await tokenLimit.fill("1");
    await budgetDialog.getByRole("button", { name: "Resume", exact: true }).click();
    await budgetDialog.getByRole("alert").getByText(/budget is still reached/).waitFor();
    expect(await tokenLimit.inputValue()).toBe("1");
    expect(budgetRequests[0].params.budget).toEqual({ maxTokens: 1 });
    expect(budgetReplies.get(budgetRequests[0].id).error.data).toEqual({ budgetSaved: false, state: "paused" });
    const store = listWorkstreamStores()[0]!;
    expect(store.read()).toMatchObject({ state: "paused", budget: { maxTokens: 3_000_000 } });
    await tokenLimit.fill("4000000");
    await budgetDialog.getByRole("button", { name: "Resume", exact: true }).click();
    await budgetDialog.waitFor({ state: "hidden" });
    expect(store.read()).toMatchObject({ state: "active", budget: { maxTokens: 4_000_000 } });
    expect(budgetRequests[1].params.budget).toEqual({ maxTokens: 4_000_000 });
    expect(budgetReplies.get(budgetRequests[1].id).result.workstream).toMatchObject({ state: "active", budget: { maxTokens: 4_000_000 } });
    expect(await page.getByRole("status").innerText()).toContain("Budget saved. Workstream resumed.");
    expect(await page.getByLabel("Budget use").innerText()).toContain("4,000,000");
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.getByRole("button", { name: "Archive", exact: true }).click(); await page.getByRole("button", { name: "Confirm archive" }).click();
    await page.getByLabel("Agents", { exact: true }).getByText("archived", { exact: true }).waitFor();
    expect(service.members.has(agent.agentId)).toBe(false);
  } finally { broker.closeWindow(19); await fixture?.close(); attached.close(); await service.stop(); await lead.close(); await d.stop(); fake.stop(); }
}, 30_000);

uiTest("desktop composer navigates and rejects or edits real Workstream proposals", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 8 }, () => (body: any) => {
    const last = JSON.stringify(body.messages.at(-1));
    return last.includes("PROPOSE")
      ? { toolCalls: [{ name: "ProposeWorkstream", input: { title: "Editable proposal", goal: "Review first", plan: "Original plan", agents: [{ name: "Reviewer", writeFiles: ["test/review.test.js"] }] } }] }
      : { text: "Proposal settled" };
  }));
  const { d } = await startTestDaemon(fake.url, undefined, { port: 0 });
  let fixture: Awaited<ReturnType<typeof openWorkstreamFixture>> | undefined;
  try {
    fixture = await openWorkstreamFixture(d, tmp("ws-proposal-ui"));
    const { page } = fixture;
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    const profile = page.getByRole("button", { name: "Test profile", exact: true });
    const focused = (locator: any) => locator.evaluate((el: Element) => el === document.activeElement);
    await editor.fill("PROPOSE");
    await editor.focus();
    await page.keyboard.press("Tab");
    expect(await focused(profile)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await focused(editor)).toBe(true);
    const send = page.getByRole("button", { name: "Send", exact: true });
    for (let step = 0; step < 12 && !await focused(send); step++) await page.keyboard.press("Tab");
    expect(await focused(send)).toBe(true);
    await page.keyboard.press("Enter");
    const proposal = page.getByRole("alertdialog", { name: "Workstream for approval" }); await proposal.waitFor();
    expect(await proposal.innerText()).toContain("test/review.test.js");
    expect(listWorkstreamStores()).toHaveLength(0);
    const reject = proposal.getByRole("button", { name: "Reject", exact: true });
    await editor.focus();
    for (let step = 0; step < 12 && !await focused(reject); step++) await page.keyboard.press("Shift+Tab");
    expect(await focused(reject)).toBe(true);
    await page.keyboard.press("Enter");
    await proposal.waitFor({ state: "hidden" }); expect(listWorkstreamStores()).toHaveLength(0);
    await editor.fill("PROPOSE"); await editor.press("Enter"); await proposal.waitFor();
    await proposal.getByRole("button", { name: "Edit plan and accept" }).click();
    await proposal.getByLabel("Workstream plan").fill("Edited plan approved by the user");
    await proposal.getByRole("button", { name: "Accept the edited plan" }).click();
    await until(() => listWorkstreamStores().length === 1);
    expect(listWorkstreamStores().find((s) => s.read().title === "Editable proposal")!.read()).toMatchObject({
      plan: "Edited plan approved by the user", writeScopes: [{ name: "Reviewer", writeFiles: ["test/review.test.js"] }],
    });
  } finally { await fixture?.close(); await d.stop(); fake.stop(); }
}, 30_000);

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { appendMessage, createSession } from "../../src/storage/transcript.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { hasProjectConfig, isFolderTrusted } from "../../src/storage/settings.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { chromiumStatus, connect, MODEL } from "../desktop/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";

const { pw, reason } = chromiumStatus("Phone mobile headless acceptance");
(reason ? test.skip : test)("paired mobile browser shares the desktop engine, answers questions and permission gates, and messages Workstreams", async () => {
  const env = tmpEnv();
  const fake = await startFakeAnthropic([
    { text: "Desktop session ready" },
    { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Language", question: "Which language?", options: ["ts", "py"] }] } }] },
    { text: "Answer received" },
    { toolCalls: [{ name: "Execute", input: { command: "echo approved from phone > allowed.txt", riskLevel: "medium", riskReason: "Writes the fixture file" } }] },
    { text: "Allowed write finished" },
    { toolCalls: [{ name: "Execute", input: { command: "echo must not write > denied.txt", riskLevel: "medium", riskReason: "Writes the fixture file" } }] },
    { text: "Still owned by desktop" },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, desktop: Awaited<ReturnType<typeof connect>> | undefined, browser: any, page: any;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fake Anthropic", baseUrl: fake.url, apiKey: "test-key-not-real" }] });
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), automations: false, sidepane: false, ws: false, backgroundServices: false });
    desktop = await connect(daemon.socketPath);
    // The original view deliberately leaves agent prompts pending for the phone to answer.
    desktop.rpc.onRequest = (method) => method === "request_trust" ? { trust: true } : new Promise(() => {});
    const opened = await desktop.call("initialize_session", { cwd: env.root, modelId: MODEL, autonomyLevel: "low", toolExecutionMode: "direct_only" });
    await desktop.call("rename_session", { title: "Shared desktop session" });
    await desktop.call("add_user_message", { text: "Start desktop fixture" }); await desktop.call("settle_session");
    const stream = new WorkstreamStore("phone-fixture");
    stream.create({ id: stream.id, title: "Phone coordination", goal: "Coordinate", plan: "Send messages", leadSessionId: opened.sessionId, cwd: env.root, state: "paused", createdAt: Date.now(), updatedAt: Date.now(), settings: { enabled: true, maxConcurrentAgents: 1, allowNestedSpawn: false, autoRejectMemberPrompts: false } });
    stream.writeRoster([{ agentId: "member", name: "Fixture member", role: "task", sessionId: opened.sessionId, cwd: env.root, model: MODEL, reasoningEffort: "low", autonomyLevel: "off", status: "interrupted", lastActivityAt: Date.now(), tokens: 0, costUsd: 0, depth: 0 }]);
    await desktop.call("phone_configure", { config: { remoteAccessEnabled: true, host: "127.0.0.1", port: 0 } });
    const pairing = await desktop.call("phone_pair");
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      (window as any).fixtureNotifications = [];
      class FixtureNotification { static permission = "default"; static async requestPermission() { this.permission = "granted"; return "granted"; } constructor(_title: string, options: any) { (window as any).fixtureNotifications.push(options.body); } }
      Object.defineProperty(window, "Notification", { value: FixtureNotification });
    });
    page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(pairing.url); expect(new URL(page.url()).hash).toBe("");
    expect(await page.locator("#fingerprint").innerText()).toBe(pairing.fingerprint);
    await page.getByLabel("Device name", { exact: true }).fill("Fixture mobile browser"); await page.getByRole("button", { name: "Pair device", exact: true }).click();
    await page.getByRole("button", { name: "Shared desktop session", exact: true }).click();
    await page.getByRole("button", { name: "Enable notifications while open", exact: true }).click();
    const send = async (text: string) => { await page.getByLabel("Message", { exact: true }).fill(text); await page.getByRole("button", { name: "Send message", exact: true }).click(); };
    await send("Ask a question");
    await page.getByLabel("Which language?", { exact: true }).fill("py"); await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await page.getByText("Answer received", { exact: true }).waitFor();
    expect(JSON.stringify(fake.requests[2].messages.at(-1))).toContain("py");
    await send("Allow a write");
    const permission = page.getByRole("region", { name: "Permission request", exact: true });
    await permission.waitFor(); await permission.getByRole("button", { name: /proceed once|allow once/i }).click();
    await page.getByText("Allowed write finished", { exact: true }).waitFor(); expect(readFileSync(join(env.root, "allowed.txt"), "utf8").trim()).toBe("approved from phone");
    await send("Deny a write"); await permission.waitFor(); await permission.getByRole("button", { name: /cancel|deny/i }).click();
    await page.getByText("The user rejected this tool call and stopped the turn.", { exact: true }).waitFor(); expect(existsSync(join(env.root, "denied.txt"))).toBe(false);
    const snapshot = await desktop.call("owned_session_snapshot"); expect(JSON.stringify(snapshot.messages)).toContain("Ask a question"); expect(fake.requests).toHaveLength(6);
    expect(desktop.notes.filter((n) => n.type === "create_message" && JSON.stringify(n.message).includes("Ask a question"))).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).fixtureNotifications.length)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Phone coordination", exact: true }).click();
    await page.getByRole("button", { name: "Open Fixture member", exact: true }).waitFor();
    await page.getByLabel("Recipient", { exact: true }).selectOption("member");
    await page.getByLabel("Workstream message", { exact: true }).fill("Coordinate from phone"); await page.getByRole("button", { name: "Send Workstream message", exact: true }).click();
    await page.getByText("user → member: Coordinate from phone", { exact: true }).waitFor();
    expect(stream.messages().at(-1)).toMatchObject({ from: "user", to: "member", priority: "later", text: "Coordinate from phone" });
    await page.reload(); await page.getByRole("button", { name: "Shared desktop session", exact: true }).click();
    const status = await desktop.call("phone_status"); expect(status.devices).toHaveLength(1);
    await desktop.call("phone_revoke", { id: status.devices[0].id }); await page.getByRole("status").filter({ hasText: "Disconnected" }).waitFor();
    await desktop.call("add_user_message", { text: "Desktop continues after revoke" }); await desktop.call("settle_session");
    expect(JSON.stringify((await desktop.call("owned_session_snapshot")).messages)).toContain("Still owned by desktop"); expect(fake.requests).toHaveLength(7); expect(errors).toEqual([]);
  } catch (e) { console.error("[phone browser]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); await desktop?.close(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 25_000);

(reason ? test.skip : test)("mobile opens stored history through the actual folder trust prompt and owns its resumed engine", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "Resumed from phone" }]);
  const previousTrust = process.env.RIGWELL_TRUST_CWD; process.env.RIGWELL_TRUST_CWD = "0";
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, browser: any, page: any;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fake Anthropic", baseUrl: fake.url, apiKey: "test-key-not-real" }] });
    writeJson(join(env.root, ".rigwell", "settings.json"), {});
    expect(hasProjectConfig(env.root)).toBe(true); expect(isFolderTrusted(env.root, {})).toBe(false);
    const files = createSession({ id: crypto.randomUUID(), cwd: env.root, title: "Stored phone history" });
    await appendMessage(files, { id: "history", role: "user", content: [{ type: "text", text: "History before pairing" }] }, null);
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), automations: false, backgroundServices: false, sidepane: false, ws: false });
    await daemon.phone.configure({ remoteAccessEnabled: true, host: "127.0.0.1", port: 0 }); const pairing = await daemon.phone.pair();
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage({ ignoreHTTPSErrors: true }); page.setDefaultTimeout(5000);
    await page.goto(pairing.url); await page.getByLabel("Device name", { exact: true }).fill("History fixture"); await page.getByRole("button", { name: "Pair device", exact: true }).click();
    await page.getByRole("button", { name: "Stored phone history", exact: true }).click(); await page.getByRole("heading", { name: "Trust this working folder?", exact: true }).waitFor();
    expect(fake.requests).toHaveLength(0); await page.getByRole("button", { name: "Continue without trusting", exact: true }).click();
    await page.getByText("History before pairing", { exact: true }).waitFor(); await page.getByLabel("Message", { exact: true }).fill("Continue stored history"); await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Resumed from phone", { exact: true }).waitFor(); expect(fake.requests).toHaveLength(1); expect(JSON.stringify(fake.requests[0].messages)).toContain("History before pairing");
  } catch (e) { console.error("[phone history]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); if (previousTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = previousTrust; }
}, 15_000);

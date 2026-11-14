import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { until } from "../workstreams/helpers.ts";
import { fakeSlack } from "../fakes/fake-slack.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { closeSessionIndexes, listSessionEntries, scanSessionEntries } from "../../src/storage/session-list.ts";
import { DelegationStore, validateDelegation } from "../../src/delegation/store.ts";
const buttons = (post: any): any[] => post?.blocks?.flatMap((b: any) => b.elements ?? []) ?? [];

test("Workstream member questions survive the lead turn and desktop answers invalidate member tokens", async () => {
  const env = tmpEnv(), slack = fakeSlack(), thread = (Date.now() / 1000).toFixed(3);
  const route = (body: any): any => {
    if (!body.tools?.length) return { text: "Fixture title" };
    const calls = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_use") : []);
    if (JSON.stringify(body.messages).includes("LEAD_PLAN")) {
      if (!calls.some((c: any) => c.name === "ProposeWorkstream")) return { toolCalls: [{ name: "ProposeWorkstream", input: { title: "Chat coordination", goal: "Answer independently", plan: "One member" } }] };
      if (!calls.some((c: any) => c.name === "SpawnAgent")) return { toolCalls: [{ name: "SpawnAgent", input: { name: "Chat member", role: "task", prompt: "MEMBER_TASK", worktree: false } }] };
      if (!calls.some((c: any) => c.name === "AskUser")) return { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Lead", question: "Lead ready?", options: ["Finish lead"] }] } }] };
      return { text: "Lead done" };
    }
    const count = calls.filter((c: any) => c.name === "AskUser").length;
    if (count < 3) return { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Member", question: ["Member first?", "Member second?", "Member third?"][count], options: [["First answer"], ["Second answer"], []][count] }] } }] };
    return { text: "Member done" };
  };
  const fake = await startFakeAnthropic(Array.from({ length: 30 }, () => route));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, desktop: RpcClient | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  try {
    setSecret("app", "fixture-app-token"); setSecret("bot", "fixture-bot-token");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fixture-key", baseUrl: fake.url }] });
    new DelegationStore().save({ projects: [{ name: "demo", cwd: env.root }], slack: { enabled: true, teamId: "T1", users: ["U1"], appTokenCredential: "app", botTokenCredential: "bot" } });
    daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, automations: false, sidepane: false, ws: false, delegation: { slackHub: slack.hub } });
    await until(() => slack.sockets.size === 1); slack.event("workstream", "demo: LEAD_PLAN", { ts: thread });
    await until(() => slack.posts.some((p) => p.text.includes("Permission required")));
    const approve = buttons(slack.posts.find((p) => p.text.includes("Permission required"))).find((b) => b.text.text === "Accept workstream");
    expect(approve).toBeDefined(); slack.action("approve-plan", approve.value, thread);
    await until(() => slack.posts.some((p) => p.text.includes("Member first?")) && slack.posts.some((p) => p.text.includes("Lead ready?")));
    const firstPost = slack.posts.find((p) => p.text.includes("Member first?")), firstToken = buttons(firstPost)[0].value;
    expect(firstPost.text).toContain("Member Chat member");
    const leadToken = buttons(slack.posts.find((p) => p.text.includes("Lead ready?")))[0].value;
    const requestsBefore = fake.requests.length;
    slack.event("ambiguous-answer", "Unaddressed answer", { type: "message", thread_ts: thread });
    await until(() => slack.posts.some((p) => p.text.includes("Several questions are pending")));
    expect(fake.requests).toHaveLength(requestsBefore);
    slack.action("finish-lead", leadToken, thread);
    await until(() => slack.posts.some((p) => p.text.startsWith("Finished") && p.text.includes("Lead done")));
    slack.action("member-first", firstToken, thread);
    await until(() => slack.posts.some((p) => p.text.includes("Member second?")));
    const results = () => fake.requests.flatMap((r) => r.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result") : []));
    expect(results().some((r: any) => typeof r.content === "string" && r.content.includes("The user answered:") && r.content.includes("First answer"))).toBe(true);
    const secondToken = buttons(slack.posts.find((p) => p.text.includes("Member second?")))[0].value;
    desktop = new RpcClient(await SocketTransport.connect(daemon.socketPath));
    const member = [...daemon.workstreams.members.values()][0]!;
    // Answer through the same Workstream method used by the desktop, rather than the lead session.
    const roster = await desktop.request("list_workstreams", {});
    const snapshot = await desktop.request("get_workstream", { id: roster.workstreams[0].id });
    expect(snapshot.pendingPrompts).toHaveLength(1);
    await desktop.request("workstream_answer_request", { id: roster.workstreams[0].id, agentId: snapshot.pendingPrompts[0].agentId, requestId: snapshot.pendingPrompts[0].requestId, answer: { answers: [{ index: 0, question: "Member second?", answer: "Desktop member answer" }] } });
    await until(() => slack.posts.some((p) => p.text.includes("Member third?")));
    expect(results().some((r: any) => typeof r.content === "string" && r.content.includes("The user answered:") && r.content.includes("Desktop member answer"))).toBe(true);
    const before = fake.requests.length; slack.action("stale-member", secondToken, thread); await until(() => slack.acks.includes("stale-member")); expect(fake.requests).toHaveLength(before);
    const third = await desktop.request("get_workstream", { id: roster.workstreams[0].id });
    expect(third.pendingPrompts).toHaveLength(1);
    slack.event("addressed-member", `answer ${third.pendingPrompts[0].requestId}: Third answer`, { type: "message", thread_ts: thread });
    await member.connection.session!.idle();
    expect(results().some((r: any) => typeof r.content === "string" && r.content.includes("The user answered:") && r.content.includes("Third answer"))).toBe(true);
  } catch (e) { console.error("[Workstream chat]", slack.posts, daemon?.delegation?.status()); throw e; }
  finally { await desktop?.close(); await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 15_000);

test("Slack delegates through real daemon engines, shares Socket Mode, binds approvals, redacts output and resumes stored sessions", async () => {
  const env = tmpEnv(), slack = fakeSlack(), marker = join(env.root, "allowed.txt"), denied = join(env.root, "denied.txt"), thread = (Date.now() / 1000).toFixed(3);
  const command = (file: string) => `node -e "require('fs').writeFileSync('${file.replace(/\\/g, "/")}','ok')"`;
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Color", question: "Which color?", options: ["Blue", "Green"] }] } }] },
    { toolCalls: [{ name: "Execute", input: { command: command(marker), riskLevel: "medium", riskReason: "Writes the fixture file" } }] }, { text: "Completed with fake-bot-secret hidden" },
    { toolCalls: [{ name: "Execute", input: { command: command(denied), riskLevel: "medium", riskReason: "Writes the denied fixture file" } }] }, { text: "Resumed after restart" },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, desktop: RpcClient | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  try {
    setSecret("app", "fake-app-secret"); setSecret("bot", "fake-bot-secret");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fake", baseUrl: fake.url }] });
    const config = { projects: [{ name: "demo", cwd: env.root }], slack: { enabled: true, teamId: "T1", users: ["U1", "U2"], appTokenCredential: "app", botTokenCredential: "bot" } };
    new DelegationStore().save(config);
    const options = { socketPath: join(env.root, "daemon.sock"), backgroundServices: false, sidepane: false as const, ws: false as const, delegation: { slackHub: slack.hub }, automations: { webhookPort: 0 } };
    daemon = await startDaemon(options);
    const auto = daemon.automations!; auto.manager.create({ name: "Shared app", trigger: "slack", eventTrigger: { appTokenCredential: "app", botTokenCredential: "bot", events: ["channel"], channels: ["C2"] } }, "Only C2"); await auto.triggers.tick();
    await until(() => slack.sockets.size === 1); expect(slack.opens).toBe(1);
    slack.event("wrong-user", "demo: no", { user: "U9", ts: thread }); slack.event("bot", "demo: no", { bot_id: "B1", ts: thread });
    slack.send("wrong-team", { team_id: "T9", event_id: "wrong-team", event: { type: "app_mention", user: "U1", channel: "C1", ts: thread, text: "demo: no" } });
    await until(() => slack.acks.length === 3); expect(fake.requests).toHaveLength(0);
    slack.event("start", "<@B1> demo: complete the task", { ts: thread });
    await until(() => slack.posts.some((p) => p.text.includes("Which color?")));
    const question = slack.posts.find((p) => p.text.includes("Which color?")), blue = buttons(question).find((b) => b.text.text === "Blue").value;
    slack.action("wrong-actor", blue, thread, { user: { id: "U2" } }); slack.action("wrong-thread", blue, "1.000"); await until(() => slack.acks.includes("wrong-thread")); expect(fake.requests).toHaveLength(1);
    slack.action("blue", blue, thread); await until(() => slack.posts.some((p) => p.text.includes("Permission required")));
    const permission = slack.posts.find((p) => p.text.includes("Permission required")), allow = buttons(permission).find((b) => b.text.text === "Allow once" || b.text.text === "Yes, allow once"); expect(allow).toBeDefined();
    desktop = new RpcClient(await SocketTransport.connect(options.socketPath));
    const binding = daemon.delegation!.store.bindings()[0]!;
    const loaded = await desktop.request("load_session", { sessionId: binding.sessionId, cwd: env.root }); expect(loaded.pendingPermissions).toHaveLength(1);
    slack.action("allow", allow.value, thread); await until(() => slack.posts.some((p) => p.text.startsWith("Finished") && p.text.includes("Completed")));
    expect(readFileSync(marker, "utf8")).toBe("ok"); expect(JSON.stringify(slack.posts)).not.toContain("fake-bot-secret");
    expect(listSessionEntries().find((s) => s.sessionId === binding.sessionId)?.source).toBe("slack"); expect(scanSessionEntries().find((s) => s.sessionId === binding.sessionId)?.source).toBe("slack");
    slack.event("start", "demo: duplicate", { ts: thread }); slack.action("replay", blue, thread); await until(() => slack.acks.includes("replay")); expect(fake.requests).toHaveLength(3);
    const before = slack.posts.length; slack.event("deny-task", "do another write", { ts: (Date.now() / 1000).toFixed(3), thread_ts: thread, type: "message" });
    await until(() => slack.posts.slice(before).some((p) => p.text.includes("Permission required")));
    const denyPost = slack.posts.slice(before).find((p) => p.text.includes("Permission required")), cancel = buttons(denyPost).find((b) => /cancel|deny|no,/i.test(b.text.text));
    slack.action("deny", cancel.value, thread); await until(() => slack.posts.slice(before).some((p) => p.text.startsWith("Finished"))); expect(existsSync(denied)).toBe(false);
    await desktop.close(); desktop = undefined; await daemon.stop(); daemon = undefined; await until(() => slack.sockets.size === 0);
    daemon = await startDaemon({ ...options, automations: false }); await until(() => slack.sockets.size === 1);
    slack.event("start", "demo: duplicate after restart", { ts: thread }); slack.event("resume", "continue", { type: "message", ts: (Date.now() / 1000).toFixed(3), thread_ts: thread });
    await until(() => slack.posts.some((p) => p.text.includes("Resumed after restart"))); expect(daemon.delegation!.store.bindings()).toHaveLength(1); expect(fake.requests).toHaveLength(5);
    await daemon.delegation!.methods.configure_delegation({ confirmed: true, config: { ...config, slack: { ...config.slack, enabled: false } } });
    expect(daemon.delegation!.status().sessions[0]!.live).toBe(false);
    expect(() => validateDelegation({ ...config, slack: { ...config.slack, users: [] } })).toThrow("user IDs");
  } catch (e) { console.error("[delegation Slack]", slack.posts, slack.acks, daemon?.delegation?.status(), fake.requests.length); throw e; }
  finally { await desktop?.close(); await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 15_000);

test("clipped permission details require review in the full Rigwell view and never expose a chat approval button", async () => {
  const env = tmpEnv(), slack = fakeSlack(), thread = (Date.now() / 1000).toFixed(3), marker = join(env.root, "clipped-write.txt");
  const command = `node -e "${" ".repeat(1800)}require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','bad')"`;
  const fake = await startFakeAnthropic([{ toolCalls: [{ name: "Execute", input: { command, riskLevel: "medium", riskReason: "Long fixture command" } }] }]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, desktop: RpcClient | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  try {
    setSecret("app", "fixture-app-token"); setSecret("bot", "fixture-bot-token");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fixture-key", baseUrl: fake.url }] });
    new DelegationStore().save({ projects: [{ name: "demo", cwd: env.root }], slack: { enabled: true, teamId: "T1", users: ["U1"], appTokenCredential: "app", botTokenCredential: "bot" } });
    daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, automations: false, sidepane: false, ws: false, delegation: { slackHub: slack.hub } });
    await until(() => slack.sockets.size === 1); slack.event("long-command", "demo: write", { ts: thread }); await until(() => slack.posts.some((p) => p.text.includes("details exceed")));
    expect(buttons(slack.posts.find((p) => p.text.includes("details exceed"))).map((b) => b.text.text)).toEqual(["Cancel"]);
    const binding = daemon.delegation!.store.bindings()[0]!; desktop = new RpcClient(await SocketTransport.connect(daemon.socketPath));
    const snapshot = await desktop.request("load_session", { sessionId: binding.sessionId, cwd: env.root }), prompt = snapshot.pendingPermissions[0];
    expect(prompt.toolUses[0].toolUse.input.command).toBe(command);
    await desktop.request("answer_request", { requestId: prompt.requestId, answer: { selectedOption: "cancel" } }); await until(() => slack.posts.some((p) => p.text.startsWith("Finished"))); expect(existsSync(marker)).toBe(false);
  } finally { await desktop?.close(); await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 10_000);

test("Slack handles temporary folder trust, multi-select and text questions, desktop answers, and revocation while approval is pending", async () => {
  const env = tmpEnv(), slack = fakeSlack(), previousTrust = process.env.RIGWELL_TRUST_CWD, thread = (Date.now() / 1000).toFixed(3), marker = join(env.root, "must-not-exist.txt");
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Scope", question: "Choose both", options: ["A", "B"], multiSelect: true }, { index: 1, topic: "Text", question: "Your text?", options: [] }] } }] },
    { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Desktop", question: "Answer on desktop", options: ["Desktop"] }] } }] },
    { toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "After", question: "After desktop?", options: ["Next"] }] } }] },
    { toolCalls: [{ name: "Execute", input: { command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','bad')"`, riskLevel: "medium", riskReason: "Fixture revocation" } }] },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, desktop: RpcClient | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))])); process.env.RIGWELL_TRUST_CWD = "0";
  try {
    setSecret("app", "fixture-app-token"); setSecret("bot", "fixture-bot-token");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fixture-key", baseUrl: fake.url }] }); writeJson(join(env.root, ".rigwell", "settings.json"), {});
    const config = { projects: [{ name: "demo", cwd: env.root }], slack: { enabled: true, teamId: "T1", users: ["U1"], appTokenCredential: "app", botTokenCredential: "bot" } };
    new DelegationStore().save(config); daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, automations: false, sidepane: false, ws: false, delegation: { slackHub: slack.hub } });
    await until(() => slack.sockets.size === 1); slack.event("trust-task", "demo: ask then write", { ts: thread });
    await until(() => slack.posts.some((p) => p.text.includes("Trust project settings?")));
    const choose = async (question: string, label: string, id: string) => { const post = slack.posts.filter((p) => p.text.includes(question)).at(-1)!; const token = buttons(post).find((b) => b.text.text === label)?.value; expect(token).toBeDefined(); slack.action(id, token, thread); await until(() => slack.acks.includes(id)); return token; };
    await choose("Trust project settings?", "Trust for this session", "trust"); await until(() => slack.posts.some((p) => p.text.includes("Choose both")));
    await choose("Choose both", "A", "a"); await until(() => slack.posts.some((p) => buttons(p).some((b) => b.text.text === "[x] A")));
    await choose("Choose both", "B", "b"); await until(() => slack.posts.some((p) => buttons(p).some((b) => b.text.text === "[x] B")));
    await choose("Choose both", "Submit selections", "submit"); await until(() => slack.posts.some((p) => p.text.includes("Your text?")));
    slack.event("text-answer", "free form answer", { type: "message", thread_ts: thread }); await until(() => slack.posts.some((p) => p.text.includes("Answer on desktop")));
    const stale = buttons(slack.posts.find((p) => p.text.includes("Answer on desktop")))[0]!.value;
    const binding = daemon.delegation!.store.bindings()[0]!; desktop = new RpcClient(await SocketTransport.connect(daemon.socketPath));
    const snapshot = await desktop.request("load_session", { sessionId: binding.sessionId, cwd: env.root }); const prompt = snapshot.pendingAskUserRequests[0];
    await desktop.request("answer_request", { requestId: prompt.requestId, answer: { answers: [{ index: 0, question: "Answer on desktop", answer: "Desktop" }] } });
    await until(() => slack.posts.some((p) => p.text.includes("After desktop?"))); slack.action("stale", stale, thread); await until(() => slack.acks.includes("stale")); expect(fake.requests).toHaveLength(3);
    slack.event("after-answer", "Next", { type: "message", thread_ts: thread }); await until(() => slack.posts.some((p) => p.text.includes("Permission required")));
    const allow = buttons(slack.posts.find((p) => p.text.includes("Permission required"))).find((b) => b.text.text === "Yes, allow once").value;
    await desktop.close(); desktop = undefined;
    await daemon.delegation!.methods.configure_delegation({ confirmed: true, config: { ...config, slack: { ...config.slack, users: ["U2"] } } });
    await until(() => slack.connections === 2); slack.action("revoked", allow, thread); await until(() => slack.acks.includes("revoked")); expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(fake.requests)).toContain("free form answer"); expect(JSON.stringify(fake.requests)).toContain("A, B");
    const saved = JSON.parse(readFileSync(join(env.rigwellHome, "settings.json"), "utf8")); expect(saved.trustedFolders ?? []).toEqual([]);
  } catch (e) { console.error("[Slack boundaries]", slack.posts, daemon?.delegation?.status()); throw e; }
  finally { await desktop?.close(); await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); if (previousTrust === undefined) delete process.env.RIGWELL_TRUST_CWD; else process.env.RIGWELL_TRUST_CWD = previousTrust; env.cleanup(); }
}, 15_000);

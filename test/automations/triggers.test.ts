import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { createAutomationService } from "../../src/automations/index.ts";
import { readSecrets, parseHeartbeat, serializeHeartbeat } from "../../src/automations/store.ts";
import { validateEventTrigger, GITHUB_EVENTS } from "../../src/automations/triggers/config.ts";
import { withLedger } from "../../src/automations/triggers/ledger.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { FakeClock } from "./helpers.ts";

test("GitHub polling dispatches all event kinds through real fake-provider sessions, persists deduplication and defaults to no posting", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now() - 1000), stamp = new Date(clock.now() + 500).toISOString(), updated = new Date(clock.now() + 600).toISOString(), old = new Date(clock.now() - 60_000).toISOString();
  const fake = await startFakeAnthropic(Array.from({ length: 8 }, () => ({ text: "Triggered run complete" }))); let posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.method === "POST") { posts++; return Response.json({ id: 1 }); }
    const p = new URL(req.url).pathname;
    if (p.endsWith("/issues")) return Response.json([{ id: 1, number: 1, created_at: stamp }, { id: 99, number: 99, created_at: old }]);
    if (p.endsWith("/issues/events")) return Response.json([{ id: 2, event: "labeled", label: { name: "ready" }, issue: { number: 1 }, created_at: stamp }, { id: 3, event: "review_requested", requested_reviewer: { login: "fixture" }, issue: { number: 2 }, created_at: stamp }]);
    if (p.endsWith("/pulls")) return Response.json([{ id: 4, number: 2, created_at: stamp, updated_at: updated }]);
    if (p.endsWith("/issues/comments")) return Response.json([{ id: 5, body: "Please @fixture look", issue_url: "https://api.github.com/repos/o/r/issues/2", updated_at: stamp }, { id: 6, body: "@fixture-other", updated_at: stamp }]);
    if (p.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 7, status: "completed", conclusion: "failure", completed_at: stamp }] });
    if (p.endsWith("/actions/runs")) return Response.json({ workflow_runs: [{ id: 8, run_attempt: 1, updated_at: stamp }] });
    return Response.json({ error: p }, { status: 404 });
  } });
  const options = { clock, webhookPort: 0, retryBaseDelayMs: 1, triggers: { github: { root: `http://127.0.0.1:${server.port}`, token: async () => "fake-token" } } };
  let service = createAutomationService(options);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake-key", baseUrl: fake.url }] });
    const config = { repos: ["o/r"], events: GITHUB_EVENTS.filter((e) => e !== "branch_pushed"), branch: "working", handle: "fixture", label: "ready" };
    const a = service.manager.create({ name: "GitHub fixture", trigger: "github", eventTrigger: config }, "Summarize the trigger data.");
    expect(parseHeartbeat(serializeHeartbeat(a.fm, a.body)).fm.eventTrigger).toEqual(config);
    await service.triggers.tick(); await service.manager.idle(); expect(fake.requests).toHaveLength(1);
    service.stop(); service = createAutomationService(options);
    for (let i = 0; i < 8; i++) { await service.triggers.tick(); await service.manager.idle(); }
    expect(fake.requests).toHaveLength(8); expect(posts).toBe(0); expect(service.manager.history(a.id).every((r) => r.trigger === "github" && r.eventId)).toBe(true);
    clock.advance(120_000); await service.triggers.tick(); await service.manager.idle(); expect(fake.requests).toHaveLength(8);
    expect(withLedger(a, (l) => l.entries("finished", 20))).toHaveLength(8);
    expect(JSON.stringify(fake.requests)).toContain("untrusted data from outside");
  } finally { service.stop(); await service.manager.idle(); server.stop(true); fake.stop(); env.cleanup(); }
}, 15_000);

test("GitHub webhook verifies HMAC/repo/branch, deduplicates and posts only to the verified source after postResult", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now() - 1000), comments: any[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { comments.push({ url: req.url, body: await req.json() }); return Response.json({ id: 9 }); } });
  const service = createAutomationService({ clock, webhookPort: 0, runner: async () => ({ ok: true, text: "Ready for review" }), triggers: { github: { root: `http://127.0.0.1:${api.port}`, token: async () => "fake-token" } } });
  try {
    const a = service.manager.create({ name: "Webhook fixture", trigger: "github", postResult: true, eventTrigger: { repos: ["o/r"], events: ["pr_opened"], transport: "webhook" } }, "Review it");
    const payload = { action: "opened", repository: { full_name: "o/r" }, pull_request: { id: 1, number: 2, created_at: new Date(clock.now() + 500).toISOString() } };
    const send = (value = payload, signature = true) => { const body = JSON.stringify(value); return fetch(`http://127.0.0.1:${service.webhookPort}/hooks/${a.id}`, { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": "fixture-delivery", "x-hub-signature-256": signature ? "sha256=" + createHmac("sha256", readSecrets(a).webhookSecret!).update(body).digest("hex") : "sha256=" + "0".repeat(64) } }); };
    expect((await send(payload, false)).status).toBe(401); expect(service.manager.history(a.id)).toHaveLength(0);
    expect((await send({ ...payload, repository: { full_name: "wrong/repo" } })).status).toBe(202); await service.triggers.tick(); expect(service.manager.history(a.id)).toHaveLength(0);
    expect((await send()).status).toBe(202); expect((await send()).status).toBe(202);
    await service.triggers.tick(); await service.manager.idle(); await service.triggers.tick();
    expect(service.manager.history(a.id)).toHaveLength(1); expect(comments).toHaveLength(1); expect(comments[0].url).toEndWith("/repos/o/r/issues/2/comments"); expect(comments[0].body.body).toContain("Ready for review");
    await service.triggers.tick(); expect(comments).toHaveLength(1);
    const ci = { repos: ["o/r"], events: ["check_failed" as const], branch: "working" };
    expect(() => validateEventTrigger("ci", { ...ci, branch: undefined })).toThrow("branch");
    expect(() => validateEventTrigger("github", { ...ci, apiRoot: "https://evil.example" })).toThrow("Unknown");
  } finally { service.stop(); await service.manager.idle(); api.stop(true); env.cleanup(); }
});

test("chained outcomes persist, wait for final failure, respect pause and cannot cycle back to ancestors", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now()); let fail = false, calls = 0;
  const service = createAutomationService({ clock, runner: async () => { calls++; return { ok: !fail, text: fail ? "Failed" : "Completed", failureReason: "agent_error" }; } });
  try {
    const a = service.manager.create({ name: "Source", trigger: "webhook" }, "Source");
    const b = service.manager.create({ name: "Follower", trigger: "chained", eventTrigger: { automationIds: [a.id], status: "any" } }, "Follow");
    service.manager.update(a.id, { trigger: "chained", eventTrigger: { automationIds: [b.id], status: "any" } });
    await service.manager.run(a.id).done; await service.triggers.tick(); await service.manager.idle(); await service.triggers.tick(); expect(calls).toBe(2);
    expect(service.manager.history(b.id)[0]!.chain).toEqual([a.id]);
    fail = true; await service.manager.run(a.id).done; await service.triggers.tick(); expect(calls).toBe(3);
    clock.advance(service.manager.limits.retryDelayMs); await service.manager.tick(); await service.manager.idle(); fail = false;
    await service.triggers.tick(); await service.manager.idle(); expect(calls).toBe(5);
    service.manager.update(b.id, { paused: true }); await service.manager.run(a.id).done; await service.triggers.tick(); expect(calls).toBe(6);
  } finally { service.stop(); await service.manager.idle(); env.cleanup(); }
});

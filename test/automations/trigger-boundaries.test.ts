import { expect, test } from "bun:test";
import { join } from "node:path";
import { createAutomationService } from "../../src/automations/index.ts";
import { GithubTriggers } from "../../src/automations/triggers/github.ts";
import { withLedger } from "../../src/automations/triggers/ledger.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { FakeClock } from "./helpers.ts";

test("an event admission transition rolls back state, run id and admission time together", () => {
  const env = tmpEnv(), service = createAutomationService({ clock: new FakeClock(Date.now()), runner: async () => ({ ok: true, text: "Finished" }) });
  try {
    const a = service.manager.create({ name: "Atomic admission", trigger: "github", eventTrigger: { repos: ["o/r"], events: ["issue_opened"], transport: "webhook" } }, "Summarize");
    service.triggers.enqueue(a, { id: "one", kind: "issue_opened", at: Date.now(), payload: {} });
    expect(() => withLedger(a, ledger => { ledger.set("one", "running", { runId: "partial" }); ledger.started("one", Date.now()); throw new Error("interrupted transition"); })).toThrow("interrupted transition");
    withLedger(a, ledger => { expect(ledger.get("one")).toMatchObject({ state: "queued", runId: null }); expect(ledger.recentCount(Date.now())).toBe(0); });
  } finally { service.stop(); env.cleanup(); }
});

test("event rate limits outlive trimmed run history and queued admission survives a restart without a second run", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now()); let runs = 0;
  const started = performance.now(), timings: { phase: string; ms: number }[] = [];
  const mark = (phase: string) => timings.push({ phase, ms: Math.round(performance.now() - started) });
  const options = { clock, runner: async () => { runs++; return { ok: true, text: "Finished" }; } }; let service = createAutomationService(options);
  try {
    const a = service.manager.create({ name: "Bounded events", trigger: "github", maxRunsPerHour: 51, eventTrigger: { repos: ["o/r"], events: ["issue_opened"], transport: "webhook" } }, "Summarize");
    mark("created");
    for (let i = 0; i < 52; i++) service.triggers.enqueue(a, { id: String(i), kind: "issue_opened", at: clock.now(), payload: { i } });
    mark("enqueued");
    for (let i = 0; i < 52; i++) { mark(`tick ${i}`); await service.triggers.tick(); mark(`idle ${i}`); await service.manager.idle(); }
    mark("dispatched");
    expect(runs).toBe(51); expect(service.manager.history(a.id)).toHaveLength(50); expect(withLedger(a, (l) => l.entries("queued"))).toHaveLength(1);
    // Simulate the crash window after begin() saved the run but before the ledger's admission update.
    withLedger(a, (l) => l.set("50", "queued")); service.stop(); service = createAutomationService(options);
    await service.triggers.tick(); await service.manager.idle(); expect(runs).toBe(51);
    service.manager.update(a.id, { paused: true }); clock.advance(3600_001); await service.triggers.tick(); expect(runs).toBe(51);
    service.manager.update(a.id, { paused: false }); await service.triggers.tick(); await service.manager.idle(); expect(runs).toBe(52);
    expect(() => service.triggers.enqueue(a, { id: "oversized", kind: "issue_opened", at: clock.now(), payload: "x".repeat(256 * 1024) })).toThrow("oversized");
  } finally { service.stop(); mark("stopped"); await service.manager.idle(); mark("drained"); env.cleanup(); if (performance.now() - started > 5000) console.error("[trigger boundary timings]", JSON.stringify(timings)); }
}, 10_000);

test("pausing an event automation also holds its pending retry until resume", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now()); let calls = 0;
  const service = createAutomationService({ clock, runner: async () => { calls++; return { ok: false, text: "", failureReason: "agent_error" }; } });
  try {
    const a = service.manager.create({ name: "Retry pause", trigger: "github", eventTrigger: { repos: ["o/r"], events: ["issue_opened"], transport: "webhook" } }, "Check it");
    service.triggers.enqueue(a, { id: "failure", kind: "issue_opened", at: clock.now(), payload: {} }); await service.triggers.tick(); await service.manager.idle(); expect(calls).toBe(1);
    service.manager.update(a.id, { paused: true }); clock.advance(service.manager.limits.retryDelayMs); await service.manager.tick(); await service.manager.idle(); expect(calls).toBe(1);
    service.manager.update(a.id, { paused: false }); await service.manager.tick(); await service.manager.idle(); expect(calls).toBe(2);
  } finally { service.stop(); await service.manager.idle(); env.cleanup(); }
});

test("GitHub uses the existing named-secret store, follows pagination, rejects redirects and never downgrades a missing credential", async () => {
  const env = tmpEnv(), headers: string[] = []; let redirected = 0;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "fixture-credentials.json"))]));
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { redirected++; return Response.json([]); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) {
    headers.push(req.headers.get("authorization") ?? ""); const url = new URL(req.url);
    if (url.pathname.includes("redirect")) return Response.redirect(`http://127.0.0.1:${destination.port}/`, 302);
    const second = url.searchParams.get("page") === "2";
    return Response.json([{ id: second ? 2 : 1, number: second ? 2 : 1, created_at: new Date().toISOString() }], { headers: second ? {} : { link: `<http://127.0.0.1:${server.port}/?page=2>; rel="next"` } });
  } });
  try {
    setSecret("trigger-key", "fake-trigger-secret"); const adapter = new GithubTriggers({ root: `http://127.0.0.1:${server.port}` });
    const config = { repos: ["o/r"], events: ["issue_opened" as const], tokenCredential: "trigger-key" };
    expect(await adapter.poll(config, 0)).toHaveLength(2); expect(headers).toEqual(["Bearer fake-trigger-secret", "Bearer fake-trigger-secret"]);
    let failure: unknown; try { await adapter.poll({ ...config, repos: ["redirect/r"] }, 0); } catch (e) { failure = e; } expect(failure).toBeDefined(); expect(redirected).toBe(0);
    let missing: unknown; try { await adapter.poll({ ...config, tokenCredential: "missing" }, 0); } catch (e) { missing = e; } expect(String(missing)).toContain("Missing stored GitHub secret"); expect(headers).toHaveLength(3);
  } finally { server.stop(true); destination.stop(true); setCredentialStore(undefined); env.cleanup(); }
});

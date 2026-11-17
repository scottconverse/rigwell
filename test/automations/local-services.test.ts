import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localService } from "../../src/automations/local-services.ts";
import { automationTools, createAutomationService } from "../../src/automations/index.ts";
import { readSecrets } from "../../src/automations/store.ts";
import { BUILTIN_SKILLS } from "../../src/skills/skills.ts";
import { toolsForSession } from "../../src/tools/registry.ts";
import { makeStubSession, call, text } from "../agent/helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { FakeClock } from "./helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { lastToolResult } from "../e2e/helpers.ts";

const context = (cwd: string) => ({ cwd, sessionId: crypto.randomUUID(), readFiles: new Map(), signal: new AbortController().signal });

test("three installers are bundled, validate source/QA settings and save ordinary project automations without running", async () => {
  const env = tmpEnv(), svc = createAutomationService({ runner: async () => { throw new Error("must not run"); } });
  try {
    const install = automationTools(svc).find((t) => t.name === "InstallLocalService")!;
    for (const service of ["code-review", "triage", "qa"]) {
      const skill = BUILTIN_SKILLS.find((s) => s.name === `install-${service}`)!;
      expect(skill.body).toContain("InstallLocalService"); expect(skill.body).toContain("postResult");
      const r = await install.run({ service, repo: "fixture/project", ...(service === "qa" ? { devCommand: "bun run dev", url: "http://127.0.0.1:4321", flows: "Save the form" } : {}) }, context(env.root));
      expect(r.isError).not.toBe(true);
    }
    expect(svc.manager.list()).toHaveLength(3);
    for (const a of svc.manager.list()) { expect(a.source).toBe("project"); expect(a.fm.postResult).toBe(false); expect(a.state.runCount).toBe(0); expect(a.fm.workingDirectory).toBe(env.root); }
    expect(() => localService({ service: "code-review", repo: "o/r", source: "push" }, env.root)).toThrow("exact branch");
    const push = localService({ service: "code-review", repo: "o/r", source: "push", branch: "work" }, env.root);
    expect(push.fm.eventTrigger).toMatchObject({ transport: "webhook", events: ["branch_pushed"] });
    const qa = { service: "qa", repo: "o/r", devCommand: "bun run dev", url: "http://127.0.0.1:4321", flows: "Save" };
    for (const patch of [{ url: "http://elsewhere.example" }, { devCommand: "dev\nmore" }, { flows: "" }, { postResult: "yes" }]) expect(() => localService({ ...qa, ...patch }, env.root)).toThrow();
    expect(localService(qa, env.root).instructions).toContain("head SHA");
  } finally { svc.stop(); await svc.manager.idle(); env.cleanup(); }
});

test("installation uses the real always-ask gate and cannot create unattended work", async () => {
  const env = tmpEnv(), svc = createAutomationService({ runner: async () => ({ ok: true, text: "unused" }) });
  try {
    for (const approve of [false, true]) {
      let prompted = 0;
      const s = makeStubSession((_r, n) => n === 0 ? call("InstallLocalService", { service: "triage", repo: "fixture/project", postResult: true }) : text("done"), {
        toolsFor: (opts) => [...toolsForSession(opts), ...automationTools(svc)], autoRejectPermissionRequests: !approve,
      }, { async requestPermission(params) { prompted++; expect(JSON.stringify(params)).toContain('"postResult":true'); return { selectedOption: "proceed_once" }; } });
      try { s.session.addUserMessage("Install issue triage"); await s.session.settled(); expect(prompted).toBe(approve ? 1 : 0); expect(svc.manager.list()).toHaveLength(approve ? 1 : 0); }
      finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
    }
  } finally { svc.stop(); await svc.manager.idle(); env.cleanup(); }
});

test("installed review and triage dispatch verified fake events through real sessions, load review skill and queue or post reports", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now()), comments: { url: string; body: any }[] = [];
  writeFileSync(join(env.root, "change.txt"), "fixture changed code\n");
  const fake = await startFakeAnthropic([
    (body) => { expect(JSON.stringify(body)).toContain("local code-review automation"); return { toolCalls: [{ name: "Skill", input: { name: "review" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("Gather the change"); return { toolCalls: [{ name: "Read", input: { path: "change.txt" } }] }; },
    (body) => { expect(lastToolResult(body)).toContain("fixture changed code"); return { text: "needs changes: medium change.txt:1 - fixture finding" }; },
    (body) => { expect(JSON.stringify(body)).toContain("suggest labels and owners"); return { text: "Suggested label: bug; duplicate: #4; owner: fixture-maintainer (check ownership)." }; },
  ]);
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", baseUrl: fake.url, apiKey: "fake-key" }] });
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { comments.push({ url: req.url, body: await req.json() }); return Response.json({ id: 1 }); } });
  const svc = createAutomationService({ clock, webhookPort: 0, retryBaseDelayMs: 1, triggers: { github: { root: `http://127.0.0.1:${api.port}`, token: async () => "fake-token" } } });
  try {
    const make = (service: string, postResult: boolean) => { const b = localService({ service, repo: "o/r", transport: "webhook", postResult }, env.root); return svc.manager.create(b.fm, b.instructions, b.project); };
    const review = make("code-review", true), triage = make("triage", false);
    const send = (a: typeof review, event: string, value: unknown) => { const raw = JSON.stringify(value); return svc.triggers.webhook(a, raw, { event, delivery: `${a.id}-fixture`, signature: "sha256=" + createHmac("sha256", readSecrets(a).webhookSecret!).update(raw).digest("hex") }); };
    clock.advance(1000);
    expect(send(review, "pull_request", { action: "opened", repository: { full_name: "o/r" }, pull_request: { id: 1, number: 2, created_at: new Date(clock.now()).toISOString() } }).httpStatus).toBe(202);
    await svc.triggers.tick(); await svc.manager.idle(); await svc.triggers.tick();
    expect(comments).toHaveLength(1); expect(comments[0]!.url).toEndWith("/repos/o/r/issues/2/comments"); expect(comments[0]!.body.body).toContain("fixture finding");
    expect(send(triage, "issues", { action: "opened", repository: { full_name: "o/r" }, issue: { id: 2, number: 3, body: "suggest labels and owners", created_at: new Date(clock.now()).toISOString() } }).httpStatus).toBe(202);
    await svc.triggers.tick(); await svc.manager.idle(); await svc.triggers.tick();
    expect(comments).toHaveLength(1); expect(svc.manager.history(triage.id)[0]!.status).toBe("success");
    const report = readdirSync(join(triage.dir, "reports")).find((f) => f.endsWith(".md"))!;
    expect(readFileSync(join(triage.dir, "reports", report), "utf8")).toContain("duplicate: #4"); expect(fake.requests).toHaveLength(4);
  } finally { svc.stop(); await svc.manager.idle(); api.stop(true); fake.stop(); env.cleanup(); }
}, 15_000);

test("signed pushes filter branch/tags/deletions, admit old commits, deduplicate and bind comments to the verified commit", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now()), comments: string[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { comments.push(req.url); return Response.json({ id: 1 }); } });
  const svc = createAutomationService({ clock, runner: async () => ({ ok: true, text: "push review" }), triggers: { github: { root: `http://127.0.0.1:${api.port}`, token: async () => "fake" } } });
  try {
    const b = localService({ service: "code-review", repo: "o/r", source: "push", branch: "work", postResult: true }, env.root), a = svc.manager.create(b.fm, b.instructions, b.project);
    const value = { repository: { full_name: "o/r" }, ref: "refs/heads/work", deleted: false, before: "0".repeat(40), after: "a".repeat(40), head_commit: { timestamp: "2000-01-01T00:00:00Z" } };
    const send = (p = value, signature = true) => { const raw = JSON.stringify(p); return svc.triggers.webhook(a, raw, { event: "push", delivery: "push-fixture", signature: "sha256=" + (signature ? createHmac("sha256", readSecrets(a).webhookSecret!).update(raw).digest("hex") : "0".repeat(64)) }); };
    expect(send(value, false).httpStatus).toBe(401);
    for (const patch of [{ ref: "refs/heads/other" }, { ref: "refs/tags/work" }, { deleted: true }, { after: "bad" }, { repository: { full_name: "wrong/repo" } }]) expect(send({ ...value, ...patch }).body.status).toBe("filtered");
    clock.advance(1000); expect(send().body.status).toBe("accepted"); expect(send().body.status).toBe("accepted");
    await svc.triggers.tick(); await svc.manager.idle(); await svc.triggers.tick();
    expect(svc.manager.history(a.id)).toHaveLength(1); expect(comments).toEqual([`http://127.0.0.1:${api.port}/repos/o/r/commits/${value.after}/comments`]);
  } finally { svc.stop(); await svc.manager.idle(); api.stop(true); env.cleanup(); }
});

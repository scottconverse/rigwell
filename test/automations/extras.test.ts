// Wave 3 automation extras: templates, per-automation VISUAL.html, guided "create by chatting" setup.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService, automationTools } from "../../src/automations/index.ts";
import { AUTOMATION_TEMPLATES, instantiateTemplate, TemplateError } from "../../src/automations/templates.ts";
import { parseSchedule } from "../../src/automations/schedule.ts";
import { renderVisual, VISUAL_MARKER } from "../../src/automations/visual.ts";
import { AUTOMATION_SETUP_OVERLAY, automationSetupParams } from "../../src/automations/setup.ts";
import type { HeadlessResult, HeadlessRunner } from "../../src/automations/runner.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { makeHome } from "../e2e/helpers.ts";
import { FakeClock, servers } from "./helpers.ts";

afterAll(() => servers.forEach((s) => s.stop()));

const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "rigwell-extras-home-"));
  process.env.RIGWELL_HOME = home;
  return home;
};
const ctx = (cwd: string) => ({ cwd, sessionId: "11111111-1111-4111-8111-111111111111", readFiles: new Map(), signal: new AbortController().signal });
const START = Date.parse("2026-03-02T00:00:00Z");

describe("templates", () => {
  test("every template is well formed and fills with its defaults", () => {
    expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    const ids = new Set<string>();
    for (const t of AUTOMATION_TEMPLATES) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(parseSchedule(t.schedule)).toBeTruthy();
      // Every placeholder in the prompt is a declared parameter and vice versa.
      const used = [...t.instructions.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      expect(new Set(used)).toEqual(new Set(t.parameters.map((p) => p.key)));
      const inst = instantiateTemplate(t.id);
      expect(inst.instructions).not.toContain("{{");
      expect(inst.name).toBe(t.name);
      expect(JSON.stringify(t)).not.toContain("—");
    }
  });

  test("parameters fill, unknown and missing ones are refused, values are not re-expanded", () => {
    const inst = instantiateTemplate("stale-branch-report", { stale_days: "45", main_branch: "develop" });
    expect(inst.instructions).toContain("older than 45 days");
    expect(inst.instructions).toContain("merged into develop");
    expect(() => instantiateTemplate("stale-branch-report", { colour: "red" })).toThrow(/no parameter "colour"/);
    expect(() => instantiateTemplate("nope")).toThrow(TemplateError);
    const sneaky = instantiateTemplate("flaky-test-triage", { test_command: "run {{repeats}}", repeats: "3" });
    expect(sneaky.instructions).toContain("Run run {{repeats}} 3 times");
  });

  test("rigwell.list_automation_templates and create_automation from a template", () => {
    fakeHome();
    const svc = createAutomationService({ clock: new FakeClock(START) });
    const listed = (svc.methods.list_automation_templates({}) as any).templates;
    expect(listed.map((t: any) => t.id)).toContain("changelog-draft");
    expect(listed[0].parameters[0]).toMatchObject({ key: expect.any(String), label: expect.any(String) });

    const made = (svc.methods.create_automation({ templateId: "dependency-update-check", parameters: { package_manager: "bun", ignore: "left-pad" }, timezone: "UTC" }) as any).automation;
    expect(made.name).toBe("Dependency update check");
    expect(made.schedule).toBe("0 9 * * 1");
    expect(made.instructions).toContain("using bun");
    expect(made.instructions).toContain("Skip these packages: left-pad");
    expect(made.nextRunAt).toBe(Date.parse("2026-03-02T09:00:00Z"));
    expect(made.lastRunAt).toBeUndefined(); // creating never starts a run

    // Fields the caller sends win over the template's.
    const own = (svc.methods.create_automation({ templateId: "daily-repo-health", name: "Mine", schedule: "hourly", timezone: "UTC" }) as any).automation;
    expect(own).toMatchObject({ name: "Mine", schedule: "hourly" });
    expect(own.instructions).toContain("Check the health");

    expect(() => svc.methods.create_automation({ templateId: "nope" })).toThrow(/Unknown template/);
    expect(() => svc.methods.create_automation({ templateId: "stale-branch-report", parameters: { bogus: "1" } })).toThrow(/no parameter/);
  });

  test("agent tools: ListAutomationTemplates, and CreateAutomation with templateId", async () => {
    fakeHome();
    const svc = createAutomationService({ clock: new FakeClock(START) });
    const tools = automationTools(svc);
    const find = (n: string) => tools.find((t) => t.name === n)!;
    const c = ctx(mkdtempSync(join(tmpdir(), "rigwell-extras-cwd-")));
    const listed = JSON.parse((await find("ListAutomationTemplates").run({}, c)).content);
    expect(listed.templates.length).toBe(AUTOMATION_TEMPLATES.length);
    const made = await find("CreateAutomation").run({ templateId: "todo-digest", parameters: { markers: "TODO" }, timezone: "UTC" }, c);
    expect(made.isError).toBeUndefined();
    expect(JSON.parse(made.content)).toMatchObject({ name: "TODO and FIXME digest", status: "active" });
    const bad = await find("CreateAutomation").run({ templateId: "todo-digest", parameters: { nope: "1" } }, c);
    expect(bad.isError).toBe(true);
  });
});

describe("VISUAL.html", () => {
  const okRun: HeadlessRunner = async () => ({ ok: true, text: "# Report\nAll is well.", sessionId: "s1" } as HeadlessResult);
  const badRun: HeadlessRunner = async () => ({ ok: false, failureReason: "agent_error", errorMessage: "boom <b>x</b>", text: "", sessionId: "s2" } as HeadlessResult);

  test("is created with the automation and rebuilt after each run", async () => {
    fakeHome();
    const clock = new FakeClock(START);
    let runner: HeadlessRunner = okRun;
    const svc = createAutomationService({ clock, runner: (r) => runner(r), retryBaseDelayMs: 1 });
    const a = svc.manager.create({ name: "Nightly check", schedule: "daily", timezone: "UTC", description: "Checks things" }, "Do it.");
    const file = join(a.dir, "VISUAL.html");
    expect(existsSync(file)).toBe(true);
    let html = readFileSync(file, "utf8");
    expect(html).toContain(VISUAL_MARKER);
    expect(html).toContain("Nightly check");
    expect(html).toContain("No runs yet");
    expect(html).toContain("2026-03-02T09:00:00Z"); // next run

    const { done } = svc.manager.run(a.id);
    await done;
    html = readFileSync(file, "utf8");
    expect(html).toContain("success");
    expect(html).toContain("All is well.");
    expect(html).toMatch(/reports\/[^<]*run-1\.md/);
    expect(html).toContain("1 total");

    runner = badRun;
    clock.advance(60_000);
    const failed = svc.manager.run(a.id);
    await failed.done;
    html = readFileSync(file, "utf8");
    expect(html).toContain("agent_error");
    expect(html).toContain("boom &lt;b&gt;x&lt;/b&gt;"); // run text is escaped
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("50%"); // one success of two finished runs
    expect(svc.manager.find(a.id).state.runCount).toBe(2);
  });

  test("is a static, sandbox-safe page", () => {
    fakeHome();
    const svc = createAutomationService({ clock: new FakeClock(START), runner: okRun });
    const a = svc.manager.create({ name: `Evil "name" <script>alert(1)</script>`, schedule: "daily", timezone: "UTC" }, "x");
    const html = renderVisual({ automation: a, runs: [], now: START });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<(img|iframe|object|embed)\b/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('addEventListener("message"'); // theme from the host app
    expect(html).not.toContain("—");
  });

  test("get_automation_visual returns path and content; a missing file is rebuilt; a hand-written page is kept", () => {
    fakeHome();
    const svc = createAutomationService({ clock: new FakeClock(START), runner: okRun });
    const a = svc.manager.create({ name: "Visual", schedule: "daily", timezone: "UTC" }, "x");
    const v = svc.methods.get_automation_visual({ id: a.id }) as any;
    expect(v.path).toBe(join(a.dir, "VISUAL.html"));
    expect(v.html).toContain("Visual");
    expect(v.generated).toBe(true);

    rmSync(v.path);
    expect((svc.methods.get_automation_visual({ id: a.id }) as any).html).toContain("Visual");

    writeFileSync(v.path, "<html><body>mine</body></html>");
    svc.manager.update(a.id, { description: "changed" });
    const kept = svc.methods.get_automation_visual({ id: a.id }) as any;
    expect(kept.html).toBe("<html><body>mine</body></html>");
    expect(kept.generated).toBe(false);

    expect(() => svc.methods.get_automation_visual({ id: "missing" })).toThrow(/not found/i);
    expect(() => svc.methods.get_automation_visual({})).toThrow(/id is required/);
  });

  test("shows paused state and the automatic pause reason after edits", () => {
    fakeHome();
    const svc = createAutomationService({ clock: new FakeClock(START), runner: okRun });
    const a = svc.manager.create({ name: "P", schedule: "daily", timezone: "UTC" }, "x");
    svc.manager.update(a.id, { paused: true });
    const html = (svc.methods.get_automation_visual({ id: a.id }) as any).html as string;
    expect(html).toContain('class="pill paused"');
    expect(html).toContain("paused"); // next run card
  });
});

describe("guided setup", () => {
  test("setup params add the overlay, tag and title without losing the caller's values", () => {
    const p = automationSetupParams({ cwd: "/x", modelId: "m", tags: [{ name: "keep" }], systemPrompt: { type: "preset", append: "Be brief." }, templateId: "todo-digest" });
    expect(p.cwd).toBe("/x");
    expect(p.modelId).toBe("m");
    expect(p.title).toBe("Automation setup");
    expect(p.tags).toEqual([{ name: "keep" }, { name: "automation-setup" }]);
    expect((p.systemPrompt as any).append).toStartWith("Be brief.");
    expect((p.systemPrompt as any).append).toContain(AUTOMATION_SETUP_OVERLAY);
    expect((p.systemPrompt as any).append).toContain('"todo-digest"');
    expect(p.templateId).toBeUndefined();
    expect(AUTOMATION_SETUP_OVERLAY).not.toContain("—");
  });

  test("the fake model interviews the user, then creates the automation after a yes", async () => {
    // The script reads the request each time, so the test also checks what the model was given.
    let sawOverlay = false, sawNextRuns = false;
    const model = await startFakeAnthropic([
      (body) => {
        const system = JSON.stringify(body.system);
        sawOverlay = system.includes("Automation setup") && system.includes("CreateAutomation");
        const names = (body.tools ?? []).map((t: any) => t.name);
        expect(names).toContain("CreateAutomation");
        expect(names).toContain("PreviewSchedule");
        expect(names).toContain("ListAutomationTemplates");
        return { text: "What should each run do, and when should it run?" };
      },
      { toolCalls: [{ id: "tu_prev", name: "PreviewSchedule", input: { schedule: "every weekday at 9am", timezone: "UTC", count: 2 } }] },
      (body) => {
        const result = JSON.stringify(body.messages.at(-1));
        sawNextRuns = result.includes("0 9 * * 1-5") && result.includes("nextRunsUtc");
        return { text: "Summary: Weekday TODO scan, 0 9 * * 1-5 UTC, user scope, default model. Create it?" };
      },
      {
        toolCalls: [{ id: "tu_create", name: "CreateAutomation", input: {
          name: "Weekday TODO scan", schedule: "every weekday at 9am", timezone: "UTC", scope: "project",
          instructions: "List TODO comments added in the last day and write them to a report.", autonomy: "low", model: "custom:Fake-Anthropic-0",
        } }],
      },
      { text: "Created. It first runs tomorrow at 09:00 UTC, and only while the daemon is running." },
    ]);
    servers.push(model);
    process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }]);
    const svc = createAutomationService({ clock: new FakeClock(START) });
    const out: any[] = [];
    const conn = createConnection((l) => {
      for (const x of l.split("\n")) {
        if (!x.trim()) continue;
        const m = JSON.parse(x);
        out.push(m);
        if (m.type === "request" && m.method === "rigwell.request_permission") {
          conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "response", id: m.id, result: { selectedOption: "proceed_once" } }) + "\n");
        }
      }
    }, { canPrompt: true, retryBaseDelayMs: 1, extraMethods: svc.methods, extraTools: () => automationTools(svc) });
    let n = 0;
    const call = async (method: string, params: Record<string, unknown>) => {
      const id = `t${++n}`;
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      for (let i = 0; i < 1000 && !out.some((m) => m.id === id); i++) await Bun.sleep(5);
      return out.find((m) => m.id === id);
    };
    const turns = () => out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length;
    const waitTurns = async (k: number) => { for (let i = 0; i < 2000 && turns() < k; i++) await Bun.sleep(10); expect(turns()).toBe(k); };

    const cwd = mkdtempSync(join(tmpdir(), "rigwell-extras-proj-"));
    const started = await call("start_automation_setup", { cwd, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "low" });
    expect(started.error).toBeUndefined();
    expect(started.result.automationSetup).toBe(true);
    expect(started.result.sessionId).toBeTruthy();

    await call("add_user_message", { text: "I want a daily TODO scan on weekdays" });
    await waitTurns(1);
    expect(sawOverlay).toBe(true);
    expect(model.requests.length).toBe(1); // it asked and stopped: nothing created yet
    expect(svc.manager.list()).toHaveLength(0);

    await call("add_user_message", { text: "Every weekday at 9am UTC, report only, in this project." });
    await waitTurns(2);
    expect(sawNextRuns).toBe(true);
    expect(svc.manager.list()).toHaveLength(0); // the summary is shown, still not created

    await call("add_user_message", { text: "Yes, create it." });
    await waitTurns(3);
    expect(model.requests.length).toBe(5);
    expect(out.some((m) => m.method === "rigwell.request_permission")).toBe(true); // creation went through the approval prompt

    const made = svc.manager.list();
    expect(made).toHaveLength(1);
    expect(made[0].fm).toMatchObject({ name: "Weekday TODO scan", schedule: "0 9 * * 1-5", timezone: "UTC", autonomy: "low" });
    expect(made[0].source).toBe("project");
    expect(made[0].dir.startsWith(cwd)).toBe(true);
    expect(made[0].body).toContain("TODO comments");
    expect(existsSync(join(made[0].dir, "VISUAL.html"))).toBe(true);
    expect(made[0].state.runCount).toBe(0);

    await call("close_session", {});
    await conn.shutdown();
  }, 40000);

  test("start_automation_setup needs a cwd", async () => {
    process.env.RIGWELL_HOME = fakeHome();
    const out: any[] = [];
    const conn = createConnection((l) => { for (const x of l.split("\n")) if (x.trim()) out.push(JSON.parse(x)); }, { canPrompt: false });
    conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "a", method: "rigwell.start_automation_setup", params: {} }) + "\n");
    for (let i = 0; i < 200 && !out.length; i++) await Bun.sleep(5);
    expect(out[0].error.message).toMatch(/cwd is required/);
    await conn.shutdown();
  });
});

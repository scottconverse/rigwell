// A small mission must not need many requests or a large prompt. The orchestrator is told the plan-file format in
// ProposeMission, so it does not read Rigwell's own source to learn the schema.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStubSession, text, call } from "../agent/helpers.ts";
import { createHash } from "node:crypto";
import { checkHandoff, MissionStore, type Feature } from "../../src/missions/store.ts";
import { orchestratorTools, workerTools, type OrchestratorEnv, type WorkerEnv } from "../../src/missions/tools.ts";
import { prepareMissionWorker } from "../../src/machines/mission-worker.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { toolsForSession } from "../../src/tools/registry.ts";
import { createCreateTool } from "../../src/tools/create.ts";
import { makeCtx } from "../tools/helpers.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); });
function missionEnv(): { env: OrchestratorEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rigwell-tools-")); roots.push(dir);
  const store = new MissionStore(dir);
  const env: OrchestratorEnv = {
    sessionId: "lead", cwd: dir, store: () => store,
    runner: () => ({ run: async () => ({ ok: true, state: "completed", message: "done", handoffs: [], counts: {}, progress: {}, tokenUsage: {} }) }) as any,
    missionSettings: () => ({ skipScrutiny: true, skipUserTesting: true }),
    confirm: async () => ({ accepted: true }),
    runningMissions: () => [], notifyState: () => {},
  };
  return { env, dir };
}

describe("mission plan-file guidance", () => {
  test("ProposeMission states the plan files and their shapes", () => {
    const { env } = missionEnv();
    const propose = orchestratorTools(env).find((t) => t.name === "ProposeMission")!;
    for (const needle of ["features.json", "validation-contract.md", "validation-state.json", "skills/<skillName>/SKILL.md", "fileAreas", "dependsOn", "\"status\":\"pending\""]) {
      expect(propose.description).toContain(needle);
    }
  });

  test("ProposeMission says the plan files are not there yet and to write them in one turn", () => {
    const { env } = missionEnv();
    const propose = orchestratorTools(env).find((t) => t.name === "ProposeMission")!;
    expect(propose.description).toContain("working_directory.txt");
    expect(propose.description).toContain("all in one turn");
    expect(propose.description).toContain("do not re-read a file you just created");
  });

  test("EndFeatureRun states the exact handoff shapes and an example", () => {
    const { dir } = missionEnv();
    const store = new MissionStore(dir);
    const env: WorkerEnv = { sessionId: "w1", store, workingDirectory: () => dir };
    const end = workerTools(env).find((t) => t.name === "EndFeatureRun")!;
    for (const needle of ['"commandsRun"', '"exitCode"', '"discoveredIssues"', '"severity"', '"salientSummary"', "whatWasImplemented"]) {
      expect(end.description).toContain(needle);
    }
    expect(end.description).toContain('"whatWasLeftUndone":""');
    // The handoff must also be a concrete JSON schema, so the model produces the right shapes on the first call
    // instead of retrying EndFeatureRun twice with a string for tests or a missing whatWasImplemented.
    const handoff = (end.inputSchema as any).properties.handoff;
    expect(handoff.required).toEqual(["salientSummary", "whatWasImplemented", "whatWasLeftUndone", "verification", "tests", "discoveredIssues"]);
    expect(handoff.properties.tests.required).toEqual(["added", "coverage"]);
    // checkHandoff does not require file/cases on tests.added items or name/verifies on cases, so the schema must not.
    expect(handoff.properties.tests.properties.added.items.required).toBeUndefined();
    expect(handoff.properties.tests.properties.added.items.properties.cases.items.required).toBeUndefined();
    expect(handoff.properties.discoveredIssues.items.properties.severity.enum).toEqual(["blocking", "non_blocking", "suggestion"]);
    // The loosest handoff that checkHandoff accepts: no file, cases or their fields.
    const h = { salientSummary: "s", whatWasImplemented: "did the work", whatWasLeftUndone: "", verification: { commandsRun: [] }, tests: { added: [{}, { cases: [{}] }], coverage: "" }, discoveredIssues: [] };
    expect(checkHandoff(h)).toHaveProperty("handoff");
  });

  test("Create returns the bytes, lines and sha256 it wrote", async () => {
    const { dir } = missionEnv();
    const body = "alpha\n";
    const r = await createCreateTool().run({ path: join(dir, "alpha.txt"), content: body }, makeCtx(dir));
    expect(r.isError).toBeFalsy();
    const saved = JSON.parse(r.content);
    expect(saved).toMatchObject({ bytes: 6, lines: 1, sha256: createHash("sha256").update(body).digest("hex") });
  });

  test("mission tool lists keep the browser tools", () => {
    // A mission session may drive a headless browser (the user-testing validator tests a web app), so
    // the mission tool lists must not filter browser_* out.
    const env = tmpEnv();
    try {
      const tool = (name: string) => ({ name, description: name, inputSchema: {}, category: "other" as const, run: async () => ({ content: "" }) });
      const w = prepareMissionWorker(
        { sessionId: "00000000-0000-4000-8000-000000000000", cwd: env.root, files: {}, tool: { name: "EndFeatureRun", description: "end", inputSchema: {} } },
        async () => ({}),
      );
      const names = w.wrap([tool("Read"), tool("browser_open"), tool("browser_screenshot"), tool("Execute")]).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["Read", "Execute", "browser_open", "browser_screenshot", "EndFeatureRun"]));
    } finally { env.cleanup(); }
  });

  test("a small mission plans and starts within a small request count and prompt size", async () => {
    const { env, dir } = missionEnv();
    const missionTools = orchestratorTools(env);
    const respond = (_req: any, n: number) => {
      if (n === 0) return call("ProposeMission", { title: "Two files", proposal: "# Two files\n\n## Overview\nAlpha and beta." });
      if (n === 1) return {
        content: [
          { type: "tool_use" as const, id: "c1", name: "Create", input: { path: join(dir, "features.json"), content: JSON.stringify({ features: [{ id: "alpha", description: "Create alpha.txt", skillName: "alpha-worker", milestone: "m1", status: "pending", fileAreas: ["alpha.txt"], dependsOn: [] }] }) } },
          { type: "tool_use" as const, id: "c2", name: "Create", input: { path: join(dir, "validation-contract.md"), content: "# Validation\n\n## A1\nalpha.txt exists." } },
          { type: "tool_use" as const, id: "c3", name: "Create", input: { path: join(dir, "validation-state.json"), content: JSON.stringify({ assertions: { A1: { status: "pending" } } }) } },
          { type: "tool_use" as const, id: "c4", name: "Create", input: { path: join(dir, "skills", "alpha-worker", "SKILL.md"), content: "---\nname: alpha-worker\ndescription: Create alpha.txt\n---\nCreate it.\n" } },
        ],
      };
      if (n === 2) return call("StartMissionRun", { message: "Run it." });
      return text("Done.");
    };
    const { session, requests } = makeStubSession(respond, {
      settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "mission", autonomyLevel: "high" },
      toolsFor: ((o: any) => [...toolsForSession(o), ...missionTools]) as any,
      skipPermissions: true,
    });
    session.addUserMessage("Plan and run two tiny files.", "turn-1");
    await session.settled();
    await session.idle();
    expect(session.lastTurn?.reason).toBe("completed");
    // Old behaviour: the orchestrator read Rigwell's source for ~14 turns and reached ~68K prompt tokens.
    expect(requests.length).toBeLessThanOrEqual(6);
    const largest = Math.max(...requests.map((r) => JSON.stringify({ system: r.system, tools: r.tools, messages: r.messages }).length));
    expect(largest).toBeLessThan(220_000); // about 55K tokens; a documented plan stays far below this
  });
});

describe("EndFeatureRun accepts a JSON-string handoff", () => {
  const handoff = { salientSummary: "Did it.", whatWasImplemented: "Implemented the feature fully.", whatWasLeftUndone: "", verification: { commandsRun: [{ command: "bun test", exitCode: 0, observation: "pass" }] }, tests: { added: [], coverage: "n/a" }, discoveredIssues: [] };
  const notText = "handoff must be a JSON object, not text. Send the fields directly. Example: ";

  function worker() {
    const { dir } = missionEnv();
    const store = new MissionStore(dir);
    store.writeFeatures([{ id: "a", description: "Feature a", skillName: "impl-worker", milestone: "m1", status: "in_progress", currentWorkerSessionId: "w1" } as Feature]);
    return { store, end: workerTools({ sessionId: "w1", store, workingDirectory: () => dir }).find((t) => t.name === "EndFeatureRun")! };
  }
  const run = (end: ReturnType<typeof worker>["end"], value: unknown) =>
    end.run({ successState: "partial", returnToOrchestrator: false, featureId: "a", handoff: value }, { sessionId: "w1" } as never);

  test("a valid handoff sent as a JSON string is accepted and stored as an object", async () => {
    const { store, end } = worker();
    const r = await run(end, JSON.stringify(handoff));
    expect(r.isError).toBeFalsy();
    const rec = store.handoffFor("w1")!;
    expect(typeof rec.handoff).toBe("object");
    expect(rec.handoff).toEqual(handoff);
  });

  test("a string that is not valid JSON is refused with the object message", async () => {
    const { end } = worker();
    const r = await run(end, "not json {");
    expect(r.isError).toBe(true);
    expect(r.content as string).toStartWith(notText);
  });

  test("a string holding a JSON array or number is refused", async () => {
    const { end } = worker();
    const arr = await run(end, JSON.stringify([handoff]));
    expect(arr.isError).toBe(true);
    expect(arr.content as string).toStartWith(notText);
    const num = await run(end, "42");
    expect(num.isError).toBe(true);
    expect(num.content as string).toStartWith(notText);
  });

  test("a string holding an object that fails checkHandoff is refused with the normal handoff error", async () => {
    const { end } = worker();
    const r = await run(end, JSON.stringify({ ...handoff, salientSummary: "" }));
    expect(r.isError).toBe(true);
    expect(r.content as string).toStartWith("handoff is invalid:");
  });

  test("a normal object still works", async () => {
    const { store, end } = worker();
    const r = await run(end, handoff);
    expect(r.isError).toBeFalsy();
    expect(store.handoffFor("w1")!.handoff).toEqual(handoff);
  });
});

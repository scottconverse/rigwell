import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTasks } from "../../src/eval/tasks.ts";
import { runTrial } from "../../src/eval/runner.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { tmpEnv } from "../storage/helpers.ts";
import solutions from "./task-solutions.json";

const names = ["csv-quoted-fields", "async-map-limit", "immutable-ranking", "tests-unique-order", "cli-search-exit-status", "layered-settings-nullish"];
for (const task of loadTasks(undefined, names)) test("the public CLI executes and grades the " + task.category + " task " + task.name, async () => {
  const env = tmpEnv(), patch = (solutions as Record<string, Record<string, string>>)[task.name]!;
  const existing = Object.keys(patch).filter((file) => existsSync(join(task.fixtureDir, file)));
  const fake = await startFakeAnthropic([
    { toolCalls: existing.map((path) => ({ name: "Read", input: { path } })) },
    { toolCalls: Object.entries(patch).map(([path, content]) => ({ name: "Create", input: { path, content, overwrite: existing.includes(path) } })) },
    { text: "Implemented the requested contract." },
  ]);
  try {
    writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify({ customModels: [{ model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "test-key-not-real" }] }));
    const result = await runTrial({ task, model: { id: "custom:Fixture-0" }, variant: { name: "baseline" }, trial: 1, autonomy: "low", timeoutMs: 10000, env: { RIGWELL_HOME: env.rigwellHome } });
    expect(result.passed, result.graderDetail).toBe(true);
    expect(result.turnReason).toBe("completed"); expect(fake.requests.length).toBe(3);
  } finally { fake.stop(); env.cleanup(); }
});

// Wave 3 over the real protocol (in-process connection): spec handoff start, org policy, secret-scan setting, compactionModelMode.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveHandoff } from "../../src/agent/handoff.ts";
import { ORG_ENV } from "../../src/storage/org.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeHome, makeRepo } from "./helpers.ts";
import { inproc } from "./inproc.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));
afterEach(() => { delete process.env[ORG_ENV]; });

async function boot(turns: any[], extraSettings: Record<string, unknown> = {}) {
  const model = await startFakeAnthropic(turns);
  servers.push(model);
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }, { provider: "anthropic", url: model.url, displayName: "Second" }]);
  process.env.RIGWELL_HOME = home;
  if (Object.keys(extraSettings).length) {
    const f = path.join(home, "settings.json");
    const cur = JSON.parse(require("node:fs").readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...cur, ...extraSettings }));
  }
  return { model, home, repo: makeRepo() };
}
const orgFile = (o: object) => { const f = path.join(mkdtempSync(path.join(tmpdir(), "rigwell-org-")), "org.json"); writeFileSync(f, JSON.stringify(o)); process.env[ORG_ENV] = f; return f; };

test("initialize_session with specHandoffId starts a turn with the spec as the brief, at the recorded autonomy", async () => {
  const { model, repo } = await boot([{ text: "starting" }]);
  const id = crypto.randomUUID();
  saveHandoff({ id, plan: "# Plan\n1. rename foo to bar", title: "Rename", specPath: "/x/spec.md", autonomyLevel: "medium", cwd: repo, fromSessionId: "old", createdAt: new Date().toISOString() });
  const a = inproc();
  const r = await a.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0", specHandoffId: id });
  expect(r.settings.autonomyLevel).toBe("medium");
  for (let i = 0; i < 4000 && !a.notes().some((n) => n.type === "agent_turn_completed"); i++) await Bun.sleep(5);
  const body = JSON.stringify(model.requests[0]);
  expect(body).toContain("rename foo to bar");
  expect(body).toContain("approved");
  await expect(inproc().call("initialize_session", { cwd: repo, specHandoffId: crypto.randomUUID() })).rejects.toThrow(/Unknown specHandoffId/);
  await expect(inproc().call("initialize_session", { cwd: repo, specHandoffId: "../etc" })).rejects.toThrow(/Unknown specHandoffId/);
  await a.call("close_session", {});
}, 30000);

test("org policy: model policy hides blocked and custom models; autonomy ceiling clamps start and updates", async () => {
  const { repo } = await boot([{ text: "x" }]);
  orgFile({ maxAutonomyLevel: "low", modelPolicy: { blockedModelIds: ["custom:Second-1"] } });
  const a = inproc();
  const r = await a.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "high" });
  expect(r.availableModels.map((m: any) => m.id)).toEqual(["custom:Fake-Anthropic-0"]);
  expect(r.settings.autonomyLevel).toBe("low");
  await a.call("update_session_settings", { autonomyLevel: "high" });
  expect(a.conn.session!.settings.autonomyLevel).toBe("low");
  await expect(a.call("update_session_settings", { modelId: "custom:Second-1" })).rejects.toThrow(/Unknown model/);
  await a.call("close_session", {});
  // skip-permissions is refused under a ceiling below high
  const b = inproc();
  await b.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0", skipPermissionsUnsafe: true });
  expect((b.conn.session as any).deps.skipPermissions).toBe(false);
  await b.call("close_session", {});
});

test("org allowCustomModels false leaves only the org's own models", async () => {
  const { repo, model } = await boot([{ text: "x" }]);
  orgFile({ modelPolicy: { allowCustomModels: false }, customModels: [{ model: "org-m", displayName: "Org Model", provider: "anthropic", baseUrl: model.url, apiKey: "k" }] });
  const a = inproc();
  const r = await a.call("initialize_session", { cwd: repo });
  expect(r.availableModels).toHaveLength(1);
  expect(r.availableModels[0].displayName).toBe("Org Model");
  await a.call("close_session", {});
});

test("settings enableSecretScan and compactionModelMode reach the session", async () => {
  const { repo } = await boot([{ text: "x" }], { enableSecretScan: true, compactionModelMode: "current-model", compactionModel: "custom:Second-1" });
  const a = inproc();
  await a.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0" });
  const deps = (a.conn.session as any).deps;
  expect(deps.enableSecretScan).toBe(true);
  expect(deps.compactionModelMode).toBe("current-model");
  // current-model mode ignores the configured compaction model
  expect((a.conn.session as any).compactionModel().id).toBe("custom:Fake-Anthropic-0");
  await a.call("close_session", {});
});

test("compactionModelMode default honors compactionModel", async () => {
  const { repo } = await boot([{ text: "x" }], { compactionModel: "custom:Second-1" });
  const a = inproc();
  await a.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0" });
  expect((a.conn.session as any).compactionModel().id).toBe("custom:Second-1");
  await a.call("close_session", {});
});

import { expect, test } from "bun:test";
import { findModel, listModelInfo, resolveModels, validateCustomModels } from "../../src/storage/models.ts";
import type { RigwellSettings } from "../../src/storage/settings.ts";

const base = { provider: "anthropic", baseUrl: "http://127.0.0.1:4010" };

test("resolves ids, env expansion (process env wins over settings.env), headers", () => {
  const s: RigwellSettings = {
    env: { FROM_SETTINGS: "fs-key", BOTH: "settings" },
    customModels: [
      { ...base, model: "fake-claude", displayName: "Fake Claude", apiKey: "${FAKE_KEY}", extraHeaders: { "X-A": "${BOTH}" }, maxOutputTokens: 100, reasoningEffort: "low" },
      { ...base, provider: "openai", model: "gpt-x", apiKey: "${FROM_SETTINGS}", noImageSupport: true },
    ],
  };
  const { models, problems } = validateCustomModels(s, { FAKE_KEY: "k1", BOTH: "proc" });
  expect(problems).toEqual([]);
  expect(models[0]).toMatchObject({ id: "custom:Fake-Claude-0", apiKey: "k1", extraHeaders: { "X-A": "proc" }, maxOutputTokens: 100, provider: "anthropic" });
  expect(models[1]).toMatchObject({ id: "custom:gpt-x-1", apiKey: "fs-key", displayName: "gpt-x", noImageSupport: true });
  expect(findModel(models, "custom:Fake-Claude-0")).toBe(models[0]);
  expect(findModel(models, "custom:gpt-x")).toBe(models[1]); // old form
  expect(findModel(models, "custom:nope")).toBeUndefined();
  const info = listModelInfo(models)[0]!;
  expect(info).toMatchObject({ id: "custom:Fake-Claude-0", isCustom: true, modelProvider: "anthropic", defaultReasoningEffort: "low" });
});

test("invalid entries are skipped with problems; indexes stay positional", () => {
  const s: RigwellSettings = {
    customModels: [
      { ...base, model: "ok" },
      { ...base, provider: "bedrock-converse", model: "b" },
      { ...base, model: "p", apiKey: "sk-..." },
      { ...base, model: "p2", apiKey: "your-api-key" },
      { ...base, model: "e", apiKey: "${UNSET_VAR_X}" },
      { ...base, model: "h", extraHeaders: { A: "1", a: "2" } },
      { provider: "openai", model: "nourl" } as any,
      { ...base, model: "good2" },
    ],
  };
  const { models, problems } = validateCustomModels(s, {});
  expect(models.map((m) => m.id)).toEqual(["custom:ok-0", "custom:good2-7"]);
  expect(problems.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(problems[3]!.message).toContain("UNSET_VAR_X");
  expect(resolveModels({})).toEqual([]);
});

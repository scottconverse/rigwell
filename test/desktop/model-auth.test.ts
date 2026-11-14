import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyForm, toEntry, toForm, validate } from "../../desktop/renderer/lib/custom-models.ts";
import { readUserSettings, updateUserSettings } from "../../desktop/main/user-settings.ts";
import { validateCustomModels } from "../../src/storage/models.ts";

test("editing supported providers preserves their format, credential source and adapter options", () => {
  for (const provider of ["google", "generic-chat-completion-api", "bedrock-converse"] as const) {
    const source = { model: "fixture-id", provider, baseUrl: "http://127.0.0.1:1234/v1", profile: { toolExecutionMode: "direct_only" }, apiProvider: "fixture", ...(provider === "bedrock-converse" ? { bedrock: { awsRegion: "us-east-1", awsAuthMethod: "profile", awsProfile: "fixture" } } : {}) };
    const form = toForm(source);
    expect(form.provider).toBe(provider);
    expect(validate(form)).toBeNull();
    const entry = toEntry(form);
    expect(entry).toMatchObject(source);
    expect(validateCustomModels({ customModels: [entry] } as any).problems).toEqual([]);
  }
  const form = toForm({ model: "fixture-id", provider: "google", credentialSource: "own-account", baseUrl: "https://example.test" });
  expect(toEntry(form).credentialSource).toBe("own-account");
  expect(toEntry(form)).not.toHaveProperty("apiKey");
  expect(validate({ ...emptyForm(), model: "fixture-id", credentialSource: "own-account", apiKey: "conflicting-key" })).toContain("cannot");
  expect(toEntry(toForm({ model: "fixture-id", provider: "generic-chat-completion-api", noImageSupport: false })).noImageSupport).toBe(false);
});

test("account client secrets and cloud credentials stay masked and round-trip without leaking", () => {
  const home = mkdtempSync(join(tmpdir(), "rigwell-model-auth-"));
  try {
    const secrets = { awsBearerToken: "private-bearer-value", awsSecretAccessKey: "private-access-value", awsSessionToken: "private-session-value", awsCredentialExport: "private-export-command", awsAuthRefresh: "private-refresh-command" };
    const original = { oauthProviders: { own: { clientId: "own-public-client", clientSecret: "private-client-value" } }, customModels: [{ model: "fixture-id", provider: "bedrock-converse", apiKeyHelper: "private-key-command", bedrock: { awsRegion: "us-east-1", ...secrets } }] };
    writeFileSync(join(home, "settings.json"), JSON.stringify(original));
    const shown = readUserSettings(home), serialized = JSON.stringify(shown);
    for (const secret of [...Object.values(secrets), "private-client-value", "private-key-command"]) expect(serialized).not.toContain(secret);
    expect(shown.oauthProviders.own.clientId).toBe("own-public-client");
    updateUserSettings(home, { oauthProviders: shown.oauthProviders, customModels: shown.customModels });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual(original);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

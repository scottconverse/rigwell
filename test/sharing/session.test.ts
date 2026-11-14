import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { appendMessage, createSession, loadSession } from "../../src/storage/transcript.ts";
import { forkImportedSession, parseSharedSession, readImportedSession, renderSharedSession, saveImportedSession, sharedSession, SHARE_MAX_BYTES } from "../../src/sharing/session.ts";
import { configuredSecretValues, redactSharedText, redactSharedValue } from "../../src/sharing/redact.ts";
import { CredentialStore, FileBackend, setCredentialStore, storeCredential } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { tokenKey } from "../../src/auth/oauth.ts";

async function fixture() {
  const env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()]));
  const files = createSession({ id: crypto.randomUUID(), cwd: env.root, title: '<script>alert("title")</script>' });
  const secret = 'opaque-value-with-"quotes"';
  setSecret("fixture", secret); storeCredential("profile-key", "profile-value-private");
  storeCredential(tokenKey("fixture-oauth"), JSON.stringify({ accessToken: "opaque-oauth-value", refreshToken: "opaque-refresh-private", tokenType: "Bearer", obtainedAt: 0 }));
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ apiKey: "keychain:profile-key" }], oauthProviders: { "fixture-oauth": {} } });
  await appendMessage(files, { id: "user-1", role: "user", content: [{ type: "text", text: `Hello ${secret} ghp_${"A".repeat(40)}\n<script>alert(1)</script>\n\`\`\`\ncontent` }, { type: "image", mediaType: "image/png", data: "private-attachment" }] }, null);
  await appendMessage(files, { id: "assistant-1", role: "assistant", content: [{ type: "thinking", thinking: "private-reasoning", signature: "private-signature" }, { type: "tool_use", id: "tool", name: "fixture", input: { password: "unknown-password", text: "profile-value-private" } }, { type: "tool_result", tool_use_id: "tool", content: "result", images: [{ type: "image", mediaType: "image/png", data: "private-tool-image" }] }] }, "user-1");
  await appendMessage(files, { id: "hidden", role: "user", visibility: "llm_only", content: [{ type: "text", text: "hidden-context" }] }, "assistant-1");
  return { env, files, secret, cleanup() { setCredentialStore(undefined); env.cleanup(); } };
}

test("HTML and Markdown exports round-trip redacted visible text without reasoning, attachments or executable markup", async () => {
  const f = await fixture();
  try {
    const values = configuredSecretValues(f.env.root); expect(values).toContain(f.secret); expect(values).toContain("profile-value-private");
    expect(values).toContain("opaque-oauth-value"); expect(values).toContain("opaque-refresh-private");
    const value = sharedSession(f.files.id);
    expect(value.messages).toHaveLength(2);
    for (const format of ["html", "markdown"] as const) {
      const result = renderSharedSession(value, format);
      for (const secret of [f.secret, "profile-value-private", "unknown-password", "private-attachment", "private-tool-image", "private-reasoning", "private-signature", "hidden-context", `ghp_${"A".repeat(40)}`]) expect(result).not.toContain(secret);
      expect(parseSharedSession(result)).toEqual(value);
    }
    const html = renderSharedSession(value, "html"); expect(html).toContain("default-src 'none'"); expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  } finally { f.cleanup(); }
});

test("imports are inert separate records until an explicit fork creates a new normal transcript", async () => {
  const f = await fixture();
  try {
    const value = sharedSession(f.files.id), imported = saveImportedSession(value);
    expect(imported.readOnly).toBe(true); expect(imported.url).toContain("rigwell://imports/");
    expect(readImportedSession(imported.importId)).toEqual(value);
    let missing: unknown; try { loadSession(imported.importId); } catch (e) { missing = e; }
    expect(String(missing)).toContain("session not found");
    const fork = await forkImportedSession(imported.importId, f.env.root), loaded = loadSession(fork.sessionId);
    expect(fork.sessionId).not.toBe(f.files.id); expect(loaded.start.importedFrom).toBe(imported.importId);
    expect(loaded.messages).toHaveLength(value.messages.length); expect(loaded.messages.every((m) => m.content.every((b) => b.type === "text"))).toBe(true);
    expect(JSON.parse(readFileSync(loaded.files.settingsPath, "utf8")).autonomyLevel).toBe("off");
    expect(loadSession(f.files.id).messages).toHaveLength(3);
  } finally { f.cleanup(); }
});

test("imports reject oversized, malformed, executable-role and path-traversal inputs without writing a session", () => {
  const env = tmpEnv();
  try {
    expect(() => parseSharedSession("x".repeat(SHARE_MAX_BYTES + 1))).toThrow("10 MiB");
    expect(() => parseSharedSession('<script>location="https://example.invalid"</script>')).toThrow("supported");
    expect(() => parseSharedSession(JSON.stringify({ schemaVersion: 1, title: "Bad", exportedAt: new Date().toISOString(), messages: [{ role: "system", text: "execute me" }] }))).toThrow("message");
    expect(() => readImportedSession("../settings")).toThrow("id");
    expect(existsSync(join(env.rigwellHome, "imports"))).toBe(false);
    const raw = JSON.stringify({ schemaVersion: 1, title: "Safe", exportedAt: new Date().toISOString(), messages: [], extra: { command: "do not execute" } });
    expect(parseSharedSession(raw)).not.toHaveProperty("extra");
  } finally { env.cleanup(); }
});

test("redaction preserves valid structured data and removes private-key bodies and common credential forms", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----";
  const value = redactSharedValue({ tokenUsage: { inputTokens: 42 }, api_key: "unknown", nested: { access_token: "other" }, text: `password=unlisted-secret Bearer bearer-fixture ${key}`, quoted: 'quoted-"secret' }, ['quoted-"secret']);
  const encoded = JSON.stringify(value);
  expect(JSON.parse(encoded)).toMatchObject({ tokenUsage: { inputTokens: 42 }, api_key: "[redacted]", nested: { access_token: "[redacted]" }, quoted: "[redacted]" });
  for (const secret of ["unlisted-secret", "bearer-fixture", "private-body"]) expect(encoded).not.toContain(secret);
  expect(redactSharedText("https://owner:password@fixture/file")).not.toContain("owner:password");
  expect(redactSharedText('{"password":"quoted-unknown-password"}')).not.toContain("quoted-unknown-password");
});

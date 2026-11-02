// AWS pieces on node:crypto: SigV4, credential sources, event-stream framing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAwsCredentialCache, decodeEventMessage, encodeEventMessage, parseCredentialOutput, resolveBedrockAuth, signV4,
} from "../../src/adapters/bedrock-auth.ts";
import { model } from "./helpers.ts";

afterEach(() => clearAwsCredentialCache());
const bm = (bedrock: object, extra: object = {}) => model("bedrock-converse", "http://x", { bedrock: { awsRegion: "us-east-1", ...bedrock }, apiKey: undefined, ...extra });

describe("SigV4", () => {
  test("matches the published get-vanilla test vector", () => {
    const h = signV4({
      method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "", region: "us-east-1", service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });

  test("a POST with a body, a session token and an encoded model id", () => {
    const h = signV4({
      method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3:0/converse-stream",
      headers: { "content-type": "application/json" }, body: '{"a":1}', region: "us-east-1", service: "bedrock",
      credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TOK" }, now: new Date("2026-01-02T03:04:05Z"),
    });
    expect(h["x-amz-security-token"]).toBe("TOK");
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20260102\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    // a different body signs differently
    const h2 = signV4({ method: "POST", url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3:0/converse-stream",
      headers: { "content-type": "application/json" }, body: '{"a":2}', region: "us-east-1", service: "bedrock",
      credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TOK" }, now: new Date("2026-01-02T03:04:05Z") });
    expect(h2.authorization).not.toBe(h.authorization);
  });
});

describe("event stream framing", () => {
  test("encode then decode, partial buffers, checksum failure", () => {
    const msg = encodeEventMessage({ ":message-type": "event", ":event-type": "contentBlockDelta" }, '{"x":"é"}');
    expect(decodeEventMessage(msg.subarray(0, msg.length - 1))).toBeUndefined();
    const d = decodeEventMessage(msg)!;
    expect(d.length).toBe(msg.length);
    expect(d.message.headers[":event-type"]).toBe("contentBlockDelta");
    expect(new TextDecoder().decode(d.message.payload)).toBe('{"x":"é"}');
    const bad = msg.slice();
    bad[bad.length - 6] ^= 0xff;
    expect(() => decodeEventMessage(bad)).toThrow(/checksum/);
  });
});

describe("credentials", () => {
  test("parseCredentialOutput reads JSON and export lines", () => {
    expect(parseCredentialOutput('{"AccessKeyId":"A","SecretAccessKey":"S","SessionToken":"T","Expiration":"2099-01-01T00:00:00Z"}'))
      .toEqual({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T", expiresAt: Date.parse("2099-01-01T00:00:00Z") });
    expect(parseCredentialOutput("export AWS_ACCESS_KEY_ID=A2\nexport AWS_SECRET_ACCESS_KEY='S2'\nexport AWS_SESSION_TOKEN=\"T2\"\n"))
      .toEqual({ accessKeyId: "A2", secretAccessKey: "S2", sessionToken: "T2" });
    expect(parseCredentialOutput("nothing here")).toBeUndefined();
  });

  test("bearer token from apiKey, awsBearerToken or the environment", async () => {
    expect(await resolveBedrockAuth(bm({}, { apiKey: "key1" }), {})).toEqual({ kind: "bearer", token: "key1" });
    expect(await resolveBedrockAuth(bm({ awsBearerToken: "tok2" }), {})).toEqual({ kind: "bearer", token: "tok2" });
    expect(await resolveBedrockAuth(bm({}), { AWS_BEARER_TOKEN_BEDROCK: "tok3" })).toEqual({ kind: "bearer", token: "tok3" });
  });

  test("access keys from the config or the environment", async () => {
    const a = await resolveBedrockAuth(bm({ awsAccessKeyId: "AK", awsSecretAccessKey: "SK", awsSessionToken: "ST" }), {});
    expect(a).toEqual({ kind: "sigv4", credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" } });
    const b = await resolveBedrockAuth(bm({}), { AWS_ACCESS_KEY_ID: "EK", AWS_SECRET_ACCESS_KEY: "ES" });
    expect(b.kind === "sigv4" && b.credentials.accessKeyId).toBe("EK");
    await expect(resolveBedrockAuth(bm({}), {})).rejects.toThrow(/access-keys auth needs/);
  });

  test("a profile of the shared credentials file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-aws-"));
    const file = join(dir, "credentials");
    writeFileSync(file, "[default]\naws_access_key_id = D1\naws_secret_access_key = D2\n\n[work]\naws_access_key_id=W1\naws_secret_access_key=W2\naws_session_token=W3\n");
    const a = await resolveBedrockAuth(bm({ awsProfile: "work" }), { AWS_SHARED_CREDENTIALS_FILE: file });
    expect(a).toEqual({ kind: "sigv4", credentials: { accessKeyId: "W1", secretAccessKey: "W2", sessionToken: "W3" } });
    await expect(resolveBedrockAuth(bm({ awsProfile: "missing" }), { AWS_SHARED_CREDENTIALS_FILE: file })).rejects.toThrow(/no static keys/);
  });

  test("credentials-command: runs the export, caches it, runs the refresh command once when the export fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-aws-"));
    const marker = join(dir, "logged-in");
    const counter = join(dir, "count");
    const exportCmd = `echo x >> ${counter}; test -f ${marker} && echo '{"AccessKeyId":"CA","SecretAccessKey":"CS","SessionToken":"CT"}'`;
    const m = bm({ awsAuthMethod: "credentials-command", awsCredentialExport: exportCmd, awsAuthRefresh: `touch ${marker}` });
    const a = await resolveBedrockAuth(m, process.env);
    expect(a).toEqual({ kind: "sigv4", credentials: expect.objectContaining({ accessKeyId: "CA", sessionToken: "CT" }) });
    const lines = (f: string) => require("node:fs").readFileSync(f, "utf8").trim().split("\n").length;
    expect(lines(counter)).toBe(2); // failed once, refreshed, succeeded
    await resolveBedrockAuth(m, process.env);
    expect(lines(counter)).toBe(2); // cached
    clearAwsCredentialCache();
    const failing = bm({ awsAuthMethod: "credentials-command", awsCredentialExport: "exit 3" });
    await expect(resolveBedrockAuth(failing, process.env)).rejects.toThrow(/failed \(exit 3\)/);
  });
});

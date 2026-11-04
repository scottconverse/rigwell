// Custom models for google and Bedrock (spec 12.2).
import { describe, expect, test } from "bun:test";
import { validateCustomModels } from "../../src/storage/models.ts";

const v = (entry: object, env: Record<string, string> = {}) => validateCustomModels({ customModels: [entry as any] }, env);

describe("google", () => {
  test("accepted, with Google's endpoint when baseUrl is left out", () => {
    const r = v({ model: "gemini-3-pro", provider: "google", apiKey: "k-real-1" });
    expect(r.problems).toEqual([]);
    expect(r.models[0]!.provider).toBe("google");
    expect(r.models[0]!.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("bedrock-converse", () => {
  test("needs the bedrock block", () => {
    expect(v({ model: "m", provider: "bedrock-converse" }).problems[0]!.message).toContain("bedrock settings are required");
  });

  test("baseUrl is derived from the region when bedrock is set; env references are expanded", () => {
    const r = v({ model: "us.anthropic.claude-x", provider: "bedrock-converse", bedrock: { awsRegion: "${R}", awsAccessKeyId: "AK", awsSecretAccessKey: "${S}" } }, { R: "eu-central-1", S: "secret" });
    expect(r.problems).toEqual([]);
    const m = r.models[0]!;
    expect(m.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
    expect(m.bedrock).toEqual({ awsRegion: "eu-central-1", awsAccessKeyId: "AK", awsSecretAccessKey: "secret" });
    expect(m.noImageSupport).toBeUndefined();
  });

  test("region falls back to AWS_REGION; unset references and bad values are reported", () => {
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: {} }, { AWS_REGION: "us-west-2" }).models[0]!.bedrock!.awsRegion).toBe("us-west-2");
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: {} }).problems[0]!.message).toContain("awsRegion is required");
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "mars" } }).problems[0]!.message).toContain("does not look like an AWS region");
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "us-east-1", awsBearerToken: "${NOPE}" } }).problems[0]!.message).toContain("NOPE");
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "us-east-1", awsAuthMethod: "magic" } }).problems[0]!.message).toContain("awsAuthMethod must be one of");
  });

  test("credentials-command needs awsCredentialExport; profile needs awsProfile", () => {
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "us-east-1", awsAuthMethod: "credentials-command" } }).problems[0]!.message).toContain("awsCredentialExport is required");
    const ok = v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "us-east-1", awsAuthMethod: "credentials-command", awsCredentialExport: "aws configure export-credentials", awsAuthRefresh: "aws sso login" } });
    expect(ok.problems).toEqual([]);
    expect(ok.models[0]!.bedrock!.awsAuthRefresh).toBe("aws sso login");
    expect(v({ model: "m", provider: "bedrock-converse", bedrock: { awsRegion: "us-east-1", awsAuthMethod: "profile" } }).problems[0]!.message).toContain("awsProfile is required");
  });
});

describe("bedrock on openai and anthropic models", () => {
  test("select the Bedrock endpoints by default", () => {
    const o = v({ model: "openai.gpt-5.4", provider: "openai", apiKey: "bk-real", bedrock: { awsRegion: "us-east-1" } }).models[0]!;
    expect(o.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    const a = v({ model: "anthropic.claude-x", provider: "anthropic", bedrock: { awsRegion: "us-east-1", awsProfile: "work" } }).models[0]!;
    expect(a.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(a.bedrock!.awsProfile).toBe("work");
  });

  test("without bedrock a baseUrl is still required", () => {
    expect(v({ model: "m", provider: "openai" }).problems[0]!.message).toContain("baseUrl must be an http(s) URL");
  });
});

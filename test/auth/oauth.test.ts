// OAuth sign-in (spec 12.2 credentialSource) against a local fake authorization server and a fake model server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AnthropicAdapter, GoogleAdapter, OpenAIResponsesAdapter } from "../../src/adapters/index.ts";
import { AuthManager, loadToken, setAuthManager, tokenKey } from "../../src/auth/oauth.ts";
import { parseOAuthProviders, type OAuthProviderConfig } from "../../src/auth/config.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { validateCustomModels } from "../../src/storage/models.ts";
import { ModelError } from "../../src/core/types.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeGoogle } from "../fakes/fake-google.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import { startFakeOAuth, type FakeOAuth } from "../fakes/fake-oauth.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { collect, request, userMsg } from "../adapters/helpers.ts";
import { inproc } from "../e2e/inproc.ts";

let env: ReturnType<typeof tmpEnv>;
let idp: FakeOAuth;
let clock = 1_000_000;
beforeEach(() => {
  env = tmpEnv();
  setCredentialStore(new CredentialStore([new FileBackend()]));
  idp = startFakeOAuth();
  clock = 1_000_000;
});
afterEach(() => { idp.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); });

const rawProvider = (extra: Record<string, unknown> = {}) => ({
  clientId: "my-own-client", authorizationEndpoint: `${idp.url}/authorize`, tokenEndpoint: `${idp.url}/token`,
  deviceAuthorizationEndpoint: `${idp.url}/device`, scopes: ["models.read"], ...extra,
});
const provider = (extra: Record<string, unknown> = {}): OAuthProviderConfig =>
  parseOAuthProviders({ acme: rawProvider(extra) }).providers.get("acme")!;
const manager = () => new AuthManager({ now: () => clock, intervalUnitMs: 5, loginTimeoutMs: 10_000 });

/** Plays the browser: follows the authorize URL, then calls the loopback redirect. */
async function browser(url: string) {
  const r1 = await fetch(url, { redirect: "manual" });
  expect(r1.status).toBe(302);
  return fetch(r1.headers.get("location")!);
}

test("provider config: validated, no built-in providers, https required", () => {
  expect(parseOAuthProviders(undefined).providers.size).toBe(0);
  const r = parseOAuthProviders({
    noClient: { tokenEndpoint: "https://x.example/token", authorizationEndpoint: "https://x.example/a" },
    plainHttp: { clientId: "c", tokenEndpoint: "http://evil.example/token", authorizationEndpoint: "https://x.example/a" },
    noFlow: { clientId: "c", tokenEndpoint: "https://x.example/token" },
    good: { clientId: "c", tokenEndpoint: "https://x.example/token", authorizationEndpoint: "https://x.example/a", clientSecret: "${NOPE_UNSET}" },
  }, {});
  expect(r.providers.size).toBe(0);
  expect(r.problems.length).toBe(4);
  const ok = provider();
  expect(ok.tokenHeader).toBe("authorization");
  expect(ok.tokenScheme).toBe("Bearer");
  expect(ok.tokenAuthMethod).toBe("none");
});

test("authorization code with PKCE over a loopback redirect", async () => {
  const m = manager();
  const st = await m.loginStart(provider());
  expect(st.kind).toBe("browser");
  const url = new URL(st.url!);
  expect(url.searchParams.get("client_id")).toBe("my-own-client");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toBe("models.read");
  expect(url.searchParams.get("redirect_uri")!.startsWith("http://127.0.0.1:")).toBe(true);
  // A redirect with the wrong state is refused and does not end the login.
  const redirect = url.searchParams.get("redirect_uri")!;
  expect((await fetch(`${redirect}?code=x&state=wrong`)).status).toBe(400);
  expect(m.loginStatus(st.loginId)!.state).toBe("pending");
  const page = await browser(st.url!);
  expect(page.status).toBe(200);
  const end = await m.waitLogin(st.loginId);
  expect(end.state).toBe("complete");
  const tok = loadToken("acme")!;
  expect(tok.accessToken).toBe("access-1");
  expect(tok.refreshToken).toBe("refresh-1");
  const req = idp.tokenRequests[0]!;
  expect(req.form.grant_type).toBe("authorization_code");
  expect(req.form.code_verifier!.length).toBeGreaterThanOrEqual(43);
  expect(req.form.client_id).toBe("my-own-client");
  expect(JSON.stringify(end)).not.toContain("access-1");
  // The loopback server is gone afterwards.
  await Bun.sleep(300);
  await expect(fetch(redirect)).rejects.toThrow();
});

test("client secret is sent as configured (basic)", async () => {
  const m = manager();
  const st = await m.loginStart(provider({ clientSecret: "shh-secret", tokenAuthMethod: "client_secret_basic" }));
  await browser(st.url!);
  await m.waitLogin(st.loginId);
  const req = idp.tokenRequests[0]!;
  expect(req.authorization).toBe(`Basic ${Buffer.from("my-own-client:shh-secret").toString("base64")}`);
  expect(req.form.client_secret).toBeUndefined();
});

test("device authorization grant polls until approved", async () => {
  idp.pendingPolls = 2;
  const m = manager();
  const st = await m.loginStart(provider(), "device");
  expect(st.kind).toBe("device");
  expect(st.userCode).toBe("ABCD-1234");
  expect(st.verificationUri).toBe(`${idp.url}/activate`);
  const end = await m.waitLogin(st.loginId);
  expect(end.state).toBe("complete");
  expect(idp.tokenRequests.filter((r) => r.form.grant_type.includes("device_code")).length).toBe(3);
  expect(loadToken("acme")!.accessToken).toBe("access-1");
});

test("device flow without an endpoint is refused", async () => {
  const cfg = provider();
  delete (cfg as any).deviceAuthorizationEndpoint;
  await expect(manager().loginStart(cfg, "device")).rejects.toThrow(/deviceAuthorizationEndpoint/);
});

test("refresh on expiry, once for concurrent callers; the refresh token is kept", async () => {
  idp.expiresIn = 120;
  const m = manager();
  const cfg = provider();
  const st = await m.loginStart(cfg);
  await browser(st.url!);
  await m.waitLogin(st.loginId);
  expect(await m.accessToken(cfg)).toBe("access-1");
  expect(idp.tokenRequests.length).toBe(1);
  clock += 100_000; // inside the 60 s skew of the 120 s lifetime
  const [a, b] = await Promise.all([m.accessToken(cfg), m.accessToken(cfg)]);
  expect(a).toBe("access-2");
  expect(b).toBe("access-2");
  const refreshes = idp.tokenRequests.filter((r) => r.form.grant_type === "refresh_token");
  expect(refreshes.length).toBe(1);
  expect(refreshes[0]!.form.refresh_token).toBe("refresh-1");
  expect(loadToken("acme")!.refreshToken).toBe("refresh-1");
  expect(await m.accessToken(cfg)).toBe("access-2"); // fresh again: no new request
  expect(idp.tokenRequests.length).toBe(2);
});

test("a revoked refresh token asks for a new sign-in; not signed in is explained", async () => {
  idp.expiresIn = 10;
  const m = manager();
  const cfg = provider();
  await expect(m.accessToken(cfg)).rejects.toThrow(/rigwell auth login acme/);
  const st = await m.loginStart(cfg);
  await browser(st.url!);
  await m.waitLogin(st.loginId);
  idp.revoked = true;
  clock += 60_000;
  await expect(m.accessToken(cfg)).rejects.toThrow(/auth login acme/);
});

function settingsWith(model: Record<string, unknown>, providers: Record<string, unknown> = { acme: rawProvider() }) {
  return { oauthProviders: providers, customModels: [model] } as any;
}

test("credentialSource cannot be combined with apiKey or apiKeyHelper; unknown source is rejected", () => {
  const base = { model: "m", provider: "anthropic", baseUrl: "http://127.0.0.1:1", credentialSource: "acme" };
  expect(validateCustomModels(settingsWith({ ...base, apiKey: "k-real-looking-123456" })).problems[0]!.message).toMatch(/cannot be combined/);
  expect(validateCustomModels(settingsWith({ ...base, apiKeyHelper: "echo k" })).problems[0]!.message).toMatch(/cannot be combined/);
  expect(validateCustomModels(settingsWith({ ...base, credentialSource: "nope" })).problems[0]!.message).toMatch(/not a valid entry of oauthProviders/);
  const ok = validateCustomModels(settingsWith(base));
  expect(ok.problems).toEqual([]);
  expect(ok.models[0]!.oauth!.name).toBe("acme");
  expect(ok.models[0]!.apiKey).toBeUndefined();
});

test("provider apiBaseUrl is the default base URL", () => {
  const r = validateCustomModels(settingsWith({ model: "m", provider: "openai", credentialSource: "acme" }, { acme: rawProvider({ apiBaseUrl: "https://api.example.test" }) }));
  expect(r.problems).toEqual([]);
  expect(r.models[0]!.baseUrl).toBe("https://api.example.test");
});

test("an adapter request carries the OAuth token, refreshed when expired; logout removes it", async () => {
  idp.expiresIn = 120;
  const mgr = manager();
  setAuthManager(mgr);
  const cfg = provider();
  const fake = await startFakeAnthropic([{ text: "one" }, { text: "two" }, { text: "three" }]);
  const [m] = validateCustomModels(settingsWith({ model: "m", provider: "anthropic", baseUrl: fake.url, credentialSource: "acme" })).models;
  try {
    // Not signed in: an auth error, and no request reaches the model server.
    await expect(collect(new AnthropicAdapter().stream(request(m!, [userMsg("hi")])))).rejects.toMatchObject({ kind: "auth" });
    expect(fake.requests.length).toBe(0);

    const st = await mgr.loginStart(cfg);
    await browser(st.url!);
    await mgr.waitLogin(st.loginId);

    await collect(new AnthropicAdapter().stream(request(m!, [userMsg("hi")])));
    expect(fake.headers[0]!.authorization).toBe("Bearer access-1");
    expect(fake.headers[0]!["x-api-key"]).toBeUndefined();

    clock += 100_000; // token expired: refreshed before the next request
    await collect(new AnthropicAdapter().stream(request(m!, [userMsg("again")])));
    expect(fake.headers[1]!.authorization).toBe("Bearer access-2");
    expect(idp.tokenRequests.filter((r) => r.form.grant_type === "refresh_token").length).toBe(1);

    // Logout: the tokens are gone from the store and from the credentials file.
    expect(mgr.logout("acme")).toBe(true);
    expect(loadToken("acme")).toBeUndefined();
    const file = readFileSync(path.join(env.rigwellHome, "credentials.json"), "utf8");
    expect(file).not.toContain("access-");
    expect(file).not.toContain("refresh-");
    expect(file).not.toContain(tokenKey("acme"));
    const err = await collect(new AnthropicAdapter().stream(request(m!, [userMsg("after")]))).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(fake.requests.length).toBe(2);
  } finally { fake.stop(); }
});

test("custom header name and scheme; works with the OpenAI adapter", async () => {
  const mgr = manager();
  setAuthManager(mgr);
  const cfg = provider({ tokenHeader: "X-Plan-Token", tokenScheme: "" });
  const st = await mgr.loginStart(cfg);
  await browser(st.url!);
  await mgr.waitLogin(st.loginId);
  const fake = await startFakeOpenAI([{ text: "ok" }]);
  try {
    const [m] = validateCustomModels(settingsWith({ model: "m", provider: "openai", baseUrl: fake.url, credentialSource: "acme" }, { acme: rawProvider({ tokenHeader: "X-Plan-Token", tokenScheme: "" }) })).models;
    await collect(new OpenAIResponsesAdapter().stream(request(m!, [userMsg("hi")])));
    expect(fake.headers[0]!["x-plan-token"]).toBe("access-1");
    expect(fake.headers[0]!.authorization).toBeUndefined();
  } finally { fake.stop(); }
});

test("protocol: auth_list, login start/status, logout; no token ever in a result", async () => {
  const fs = await import("node:fs");
  fs.writeFileSync(path.join(env.rigwellHome, "settings.json"), JSON.stringify({ oauthProviders: { acme: rawProvider() } }));
  const mgr = manager();
  setAuthManager(mgr);
  const c = inproc();
  const seen: string[] = [];
  const call = async (m: string, p: Record<string, unknown> = {}) => { const r = await c.call(m, p); seen.push(JSON.stringify(r)); return r; };
  let list = await call("auth_list");
  expect(list.providers[0]).toMatchObject({ name: "acme", loggedIn: false, browserLogin: true, deviceLogin: true });
  const st = await call("auth_login_start", { name: "acme" });
  expect(st.state).toBe("pending");
  expect((await call("auth_login_status", { loginId: st.loginId })).state).toBe("pending");
  await browser(st.url);
  await mgr.waitLogin(st.loginId);
  expect((await call("auth_login_status", { loginId: st.loginId })).state).toBe("complete");
  list = await call("auth_list");
  expect(list.providers[0]).toMatchObject({ loggedIn: true, hasRefreshToken: true });
  const dev = await call("auth_login_start", { name: "acme", mode: "device" });
  expect(dev.userCode).toBe("ABCD-1234");
  await mgr.waitLogin(dev.loginId);
  expect((await call("auth_logout", { name: "acme" })).loggedOut).toBe(true);
  expect((await call("auth_list")).providers[0].loggedIn).toBe(false);
  await expect(c.call("auth_login_start", { name: "missing" })).rejects.toThrow(/No OAuth provider/);
  expect(seen.join("\n")).not.toMatch(/access-|refresh-/);
});


test("Google account token is required, refreshed and removed without using an API key", async () => {
  idp.expiresIn = 120;
  const mgr = manager(); setAuthManager(mgr);
  const fake = await startFakeGoogle([{ text: "one" }, { text: "two" }]);
  const [m] = validateCustomModels(settingsWith({ model: "fixture-id", provider: "google", baseUrl: fake.url, credentialSource: "acme" })).models;
  const run = () => collect(new GoogleAdapter().stream(request(m!, [userMsg("hello")])));
  try {
    const unsigned = await run().catch((e) => e);
    expect(unsigned).toMatchObject({ kind: "auth" });
    expect(fake.requests.length).toBe(0);
    const st = await mgr.loginStart(provider()); await browser(st.url!); await mgr.waitLogin(st.loginId);
    await run(); expect(fake.headers[0]!.authorization).toBe("Bearer access-1");
    expect(fake.headers[0]!["x-goog-api-key"]).toBeUndefined();
    clock += 100_000;
    await run(); expect(fake.headers[1]!.authorization).toBe("Bearer access-2");
    expect(idp.tokenRequests.filter((r) => r.form.grant_type === "refresh_token").length).toBe(1);
    idp.revoked = true; clock += 100_000;
    expect(await run().catch((e) => e)).toMatchObject({ kind: "auth", retryable: false });
    expect(fake.requests.length).toBe(2);
    expect(mgr.logout("acme")).toBe(true);
    expect(loadToken("acme")).toBeUndefined();
  } finally { fake.stop(); }
});

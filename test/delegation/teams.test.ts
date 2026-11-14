import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { TeamsConnector } from "../../src/delegation/teams.ts";
import { DelegationStore, validateDelegation } from "../../src/delegation/store.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { until } from "../workstreams/helpers.ts";
import { closeSessionIndexes, listSessionEntries } from "../../src/storage/session-list.ts";

const appId = "11111111-1111-4111-8111-111111111111", tenantId = "22222222-2222-4222-8222-222222222222", user = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
const config = { enabled: true, tenantId, appId, users: [user, other], secretCredential: "teams", port: 0, publicUrl: "https://tunnel.example/api/delegation/teams" };
function fixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "fixture", kty: "RSA", use: "sig", endorsements: ["msteams"] };
  const posts: any[] = [], requests: { url: string; headers: Headers; body: any }[] = []; let now = Date.now();
  const fetcher = (async (input: any, init: RequestInit = {}) => {
    const url = String(input); requests.push({ url, headers: new Headers(init.headers), body: init.body }); expect(init.redirect).toBe("error");
    if (url.endsWith("/metadata")) return Response.json({ issuer: "https://api.botframework.com", jwks_uri: "https://identity.example/keys", id_token_signing_alg_values_supported: ["RS256"] });
    if (url.endsWith("/keys")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/token")) return Response.json({ token_type: "Bearer", expires_in: 3600, access_token: "fake-access-token" });
    if (url.startsWith("https://smba.trafficmanager.net/amer/v3/conversations/")) { posts.push(JSON.parse(init.body as string)); return Response.json({ id: `reply-${posts.length}` }); }
    throw new Error("Unexpected fixture destination");
  }) as typeof fetch;
  const deps = { fetch: fetcher, metadataUrl: "https://identity.example/metadata", tokenUrl: "https://identity.example/token", credential: () => "fake-teams-secret", now: () => now };
  const activity = (id: string, text: string, patch: any = {}) => ({ id, type: "message", timestamp: new Date().toISOString(), channelId: "msteams", serviceUrl: "https://smba.trafficmanager.net/amer/", from: { id: "29:fixture", aadObjectId: user }, recipient: { id: `28:${appId}` }, channelData: { tenant: { id: tenantId } }, conversation: { id: "personal-conversation", conversationType: "personal" }, text, ...patch });
  const jwt = (a: any, patch: any = {}, h: any = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture", ...h })).toString("base64url"), payload = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: appId, nbf: now / 1000 - 10, exp: now / 1000 + 3600, serviceurl: a.serviceUrl, ...patch })).toString("base64url");
    return `Bearer ${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  };
  return { deps, posts, requests, activity, jwt, jwk, advance(ms: number) { now += ms; } };
}
test("Teams verifies issuer, audience, validity, RSA keys/endorsement, tenant/user and service URL before sending scoped tokens", async () => {
  const f = fixture(), connector = new TeamsConnector(config, f.deps), a = f.activity("one", "demo: hello");
  try {
    expect((await connector.authenticate(f.jwt(a), a)).user).toBe(user);
    const group = f.activity("group", "follow up", { conversation: { id: "group-conversation", conversationType: "groupChat" } }); expect((await connector.authenticate(f.jwt(group), group)).thread).toBe("");
    const channel = f.activity("reply", "follow up", { conversation: { id: "channel-thread", conversationType: "channel" }, replyToId: "root" }); expect((await connector.authenticate(f.jwt(channel), channel)).thread).toBe("root");
    for (const patch of [{ aud: "wrong" }, { iss: "https://evil.example" }, { exp: Date.now() / 1000 - 1000 }, { nbf: Date.now() / 1000 + 1000 }, { serviceurl: "https://evil.example/" }, { exp: undefined }]) {
      let error: unknown; try { await connector.authenticate(f.jwt(a, patch), a); } catch (e) { error = e; } expect(error).toBeInstanceOf(Error);
    }
    for (const changed of [f.activity("two", "no", { channelId: "emulator" }), f.activity("three", "no", { from: { aadObjectId: "not-allowed" } }), f.activity("four", "no", { channelData: { tenant: { id: other } } }), f.activity("five", "no", { serviceUrl: "https://evil.example/" })]) {
      let error: unknown; try { await connector.authenticate(f.jwt(changed), changed); } catch (e) { error = e; } expect(error).toBeInstanceOf(Error);
    }
    let invalid: unknown; try { await connector.authenticate(f.jwt(a).slice(0, -8) + "AAAAAAAA", a); } catch (e) { invalid = e; } expect(invalid).toBeInstanceOf(Error);
    const source = await connector.authenticate(f.jwt(a), a); await connector.send(source, "A reply"); await connector.send(source, "Another reply");
    expect(f.requests.filter((r) => r.url.endsWith("/token"))).toHaveLength(1); expect(f.requests.at(-1)!.headers.get("authorization")).toBe("Bearer fake-access-token");
    expect(new URLSearchParams(f.requests.find((r) => r.url.endsWith("/token"))!.body).get("scope")).toBe("https://api.botframework.com/.default");
    f.jwk.endorsements = []; f.advance(24 * 60 * 60_000);
    let endorsement: unknown; try { await connector.authenticate(f.jwt(a), a); } catch (e) { endorsement = e; } expect(endorsement).toBeInstanceOf(Error);
  } finally { connector.stop(); }
});

test("signed Teams activities drive a desktop-visible real session, questions and allow/deny buttons, while rejecting untrusted requests", async () => {
  const env = tmpEnv(), f = fixture(), marker = join(env.root, "teams-allowed.txt"), denied = join(env.root, "teams-denied.txt");
  const command = (file: string) => `node -e "require('fs').writeFileSync('${file.replace(/\\/g, "/")}','ok')"`;
  const fake = await startFakeAnthropic([{ toolCalls: [{ name: "AskUser", input: { questions: [{ index: 0, topic: "Scope", question: "Which scope?", options: ["Local", "All"] }] } }] }, { toolCalls: [{ name: "Execute", input: { command: command(marker), riskLevel: "medium", riskReason: "Fixture write" } }] }, { text: "Teams completed" }, { toolCalls: [{ name: "Execute", input: { command: command(denied), riskLevel: "medium", riskReason: "Denied write" } }] }]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fixture-key", baseUrl: fake.url }] });
    new DelegationStore().save({ projects: [{ name: "demo", cwd: env.root }], teams: config });
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, sidepane: false, automations: false, ws: false, delegation: { teams: f.deps } });
    const endpoint = `http://127.0.0.1:${daemon.delegation!.status().listener!.port}/api/delegation/teams`;
    const post = (a: any, auth = f.jwt(a)) => fetch(endpoint, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(a) });
    expect((await post(f.activity("unauthorized", "demo: no"), "")).status).toBe(403); expect((await post(f.activity("wrong-user", "demo: no", { from: { aadObjectId: "bad" } }))).status).toBe(403); expect(fake.requests).toHaveLength(0);
    const first = f.activity("start", "demo: do the task"); expect((await post(first)).status).toBe(200);
    await until(() => f.posts.some((p) => p.text.includes("Which scope?")));
    const action = (post: any, label: string) => post.attachments[0].content.actions.find((a: any) => a.title === label).data.token;
    const invoke = (id: string, token: string, patch: any = {}) => f.activity(id, "", { type: "invoke", name: "adaptiveCard/action", value: { action: { verb: "rigwell.answer", data: { token } } }, ...patch });
    const token = action(f.posts.find((p) => p.text.includes("Which scope?")), "Local");
    expect((await (await post(invoke("wrong-actor", token, { from: { aadObjectId: other } }))).json()).statusCode).toBe(403);
    expect((await (await post(invoke("answer", token))).json()).statusCode).toBe(200);
    await until(() => f.posts.some((p) => p.text.includes("Permission required")));
    const allow = action(f.posts.find((p) => p.text.includes("Permission required")), "Yes, allow once"); await post(invoke("allow", allow));
    await until(() => f.posts.some((p) => p.text.includes("Teams completed"))); expect(readFileSync(marker, "utf8")).toBe("ok");
    expect(listSessionEntries()[0]!.source).toBe("teams"); expect(daemon.delegation!.status().sessions).toHaveLength(1);
    await post(first); await post(invoke("replay", token)); expect(fake.requests).toHaveLength(3);
    const count = f.posts.length; await post(f.activity("second", "do another write")); await until(() => f.posts.slice(count).some((p) => p.text.includes("Permission required")));
    const deny = action(f.posts.slice(count).find((p) => p.text.includes("Permission required")), "No, cancel"); await post(invoke("deny", deny)); await until(() => f.posts.slice(count).some((p) => p.text.startsWith("Finished"))); expect(existsSync(denied)).toBe(false);
    expect(() => validateDelegation({ projects: [], teams: config })).toThrow("Add a project");
  } catch (e) { console.error("[Teams delegation]", f.posts, daemon?.delegation?.status()); throw e; }
  finally { await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 15_000);

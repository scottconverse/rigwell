import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { handleCodeProviderMethod, codeProviderToken, type CodeProviderDeps } from "../../src/auth/code-providers.ts";
import { AuthManager, loadToken, setAuthManager, tokenKey } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, lookupCredential, setCredentialStore, storeCredential } from "../../src/storage/credentials.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { createPr, getPrStatus } from "../../src/worktree/pr.ts";
import { startFakeOAuth } from "../fakes/fake-oauth.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { makeGitRepo, sh, tmp } from "../worktree/util.ts";

let env: ReturnType<typeof tmpEnv>, idp: ReturnType<typeof startFakeOAuth>;
let settings: any, deps: CodeProviderDeps, requests: { path: string; token: string | null }[];
let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()]));
  idp = startFakeOAuth(); idp.pendingPolls = 2;
  setAuthManager(new AuthManager({ intervalUnitMs: 10 }));
  settings = { oauthProviders: Object.fromEntries(["github", "gitlab"].map((p) => [p, { clientId: `rigwell-${p}-fixture`, tokenEndpoint: `${idp.url}/token`, deviceAuthorizationEndpoint: `${idp.url}/device`, scopes: ["repo"] }])) };
  requests = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname, token = req.headers.get("authorization"); requests.push({ path, token });
    if (token === "Bearer rejected") return new Response("not a credential echo", { status: 401 });
    if (path === "/user") return Response.json({ login: "fixture-user" }, token === "Bearer granular" ? {} : { headers: { "x-oauth-scopes": "repo, read:user" } });
    if (path === "/api/v4/user") return Response.json({ username: "fixture-gitlab" });
    if (path === "/api/v4/personal_access_tokens/self") return Response.json({ scopes: ["api", "read_user"] });
    if (path === "/oauth/token/info") return Response.json({ scope: ["api"] });
    if (req.method === "POST" && path.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/fixture/repo/pull/8", number: 8 });
    if (path.endsWith("/pulls")) return Response.json([{ number: 8, html_url: "https://github.com/fixture/repo/pull/8", state: "open" }]);
    if (path.endsWith("/pulls/8")) return Response.json({ number: 8, html_url: "https://github.com/fixture/repo/pull/8", state: "open", head: { sha: "fixture-head" } });
    return Response.json({ state: "success", statuses: [], check_runs: [] });
  } });
  deps = { apiRoot: () => `http://127.0.0.1:${server.port}` };
});
afterEach(() => { idp.stop(); server.stop(true); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); });
const call = async (method: string, params: Record<string, unknown> = {}) => {
  const r = await handleCodeProviderMethod(`code_provider_${method}`, params, () => settings, deps);
  if (!r.handled) throw new Error("unhandled"); return r.result as any;
};
const until = async (pred: () => Promise<boolean>) => {
  const end = Date.now() + 2000;
  while (!await pred()) { if (Date.now() >= end) throw new Error("condition not reached"); await Bun.sleep(5); }
};

test("tokens verify before replacement, show account/scopes, never return credentials and disconnect locally", async () => {
  expect((await call("list")).connections.every((c: any) => !c.connected)).toBe(true);
  const connected = await call("connect", { provider: "github", token: "private-fixture-token" });
  expect(connected).toMatchObject({ connected: true, account: "fixture-user", scopes: ["repo", "read:user"] });
  const error = await call("connect", { provider: "github", token: "rejected" }).then(() => null, (e) => e);
  expect(error.message).toContain("401"); expect(lookupCredential("github")).toBe("private-fixture-token");
  expect(JSON.stringify(await call("list"))).not.toContain("private-fixture-token");
  await call("connect", { provider: "gitlab", token: "gitlab-token" });
  expect((await call("list")).connections[1]).toMatchObject({ account: "fixture-gitlab", scopes: ["api", "read_user"] });
  await call("connect", { provider: "github", token: "granular" });
  expect((await call("list")).connections[0].scopes).toBeUndefined();
  await call("disconnect", { provider: "github" });
  expect(await codeProviderToken("github", settings)).toBeUndefined();
  expect(requests.every((r) => r.token?.startsWith("Bearer "))).toBe(true);
});

test("registered device flow, refresh, cancellation and missing registration use the existing OAuth manager", async () => {
  await call("connect", { provider: "gitlab", token: "working-token" });
  idp.pendingPolls = 100;
  const cancelled = await call("login_start", { provider: "gitlab" });
  await call("login_cancel", { provider: "gitlab", loginId: cancelled.loginId });
  expect(await codeProviderToken("gitlab", settings)).toBe("working-token");
  idp.pendingPolls = 0;
  const first = await call("login_start", { provider: "gitlab" });
  expect(first.userCode).toBe("ABCD-1234");
  let done: any;
  await until(async () => { done = await call("login_status", { provider: "gitlab", loginId: first.loginId }); return done.state === "complete"; });
  expect(done.connection).toMatchObject({ account: "fixture-gitlab", source: "oauth", scopes: ["api"] });
  expect(lookupCredential("gitlab")).toBeUndefined(); expect(loadToken("gitlab")?.refreshToken).toBeTruthy();
  storeCredential(tokenKey("gitlab"), JSON.stringify({ ...loadToken("gitlab"), expiresAt: 0 }));
  const before = idp.issued;
  expect(await codeProviderToken("gitlab", settings)).toBe(`access-${before + 1}`);
  expect(idp.tokenRequests.at(-1)?.form.grant_type).toBe("refresh_token");
  const wrong = await call("login_status", { provider: "github", loginId: first.loginId }).then(() => null, (e) => e);
  expect(wrong.message).toContain("Unknown");
  await call("disconnect", { provider: "gitlab" }); expect(loadToken("gitlab")).toBeUndefined();
  settings = {};
  expect((await call("list")).connections.every((c: any) => !c.deviceLogin)).toBe(true);
  expect((await call("login_start", { provider: "github" }).then(() => null, (e) => e)).message).toContain("registered client ID");
  expect((await call("connect", { provider: "elsewhere", token: "bad" }).then(() => null, (e) => e)).code).toBe(-32602);
});

test("normal protocol dispatch never exposes tokens, and API PR creation reuses a verified saved connection", async () => {
  writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify(settings));
  const out: any[] = [];
  const conn = createConnection((line) => { for (const l of line.trim().split("\n")) out.push(JSON.parse(l)); }, { canPrompt: false, codeProviderDeps: deps });
  conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "connect", method: "rigwell.code_provider_connect", params: { provider: "github", token: "connected-token" } }) + "\n");
  await until(async () => out.some((r) => r.id === "connect"));
  expect(out[0].result.account).toBe("fixture-user"); expect(JSON.stringify(out)).not.toContain("connected-token");
  await conn.shutdown();
  const repo = makeGitRepo(), bare = tmp("connection-bare");
  sh(bare, "init", "--bare", "-q", "-b", "main"); sh(repo, "remote", "add", "origin", bare); sh(repo, "checkout", "-qb", "feature/connection");
  let approvals = 0;
  const prDeps = { which: () => null, apiRoot: () => `http://127.0.0.1:${server.port}`, repo: () => ({ provider: "github" as const, host: "github.com", project: "fixture/repo" }) };
  const result = await createPr(repo, {}, async () => { approvals++; return { selectedOption: "proceed_once" }; }, prDeps);
  expect(result.number).toBe(8); expect(approvals).toBe(1);
  expect(sh(bare, "rev-parse", "refs/heads/feature/connection")).toBe(sh(repo, "rev-parse", "HEAD"));
  expect((await getPrStatus(repo, prDeps)).state).toBe("open");
  expect(requests.filter((r) => r.path.startsWith("/repos/")).every((r) => r.token === "Bearer connected-token")).toBe(true);
});

test("API PR preflight refreshes the connected OAuth token and a failed refresh prevents the push", async () => {
  writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify(settings));
  const login = await call("login_start", { provider: "github" });
  await until(async () => (await call("login_status", { provider: "github", loginId: login.loginId })).state === "complete");
  storeCredential(tokenKey("github"), JSON.stringify({ ...loadToken("github"), expiresAt: 0 }));
  const repo = makeGitRepo(), bare = tmp("oauth-pr-bare");
  sh(bare, "init", "--bare", "-q", "-b", "main"); sh(repo, "remote", "add", "origin", bare); sh(repo, "checkout", "-qb", "feature/oauth");
  const prDeps = { which: () => null, apiRoot: () => `http://127.0.0.1:${server.port}`, repo: () => ({ provider: "github" as const, host: "github.com", project: "fixture/repo" }) };
  const before = idp.issued;
  await createPr(repo, {}, async () => ({ selectedOption: "proceed_once" }), prDeps);
  expect(idp.issued).toBe(before + 1);
  expect(requests.at(-1)?.token).toBe(`Bearer access-${before + 1}`);
  sh(repo, "checkout", "-qb", "feature/refused"); idp.revoked = true;
  storeCredential(tokenKey("github"), JSON.stringify({ ...loadToken("github"), expiresAt: 0 }));
  let approvals = 0;
  const error = await createPr(repo, {}, async () => { approvals++; return { selectedOption: "proceed_once" }; }, prDeps).then(() => null, (e) => e);
  expect(error.code).toBe("expired"); expect(error.message).toContain("revoked or expired"); expect(approvals).toBe(0);
  expect(() => sh(bare, "show-ref", "--verify", "refs/heads/feature/refused")).toThrow();
});

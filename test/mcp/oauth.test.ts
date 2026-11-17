import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpManager } from "../../src/mcp/manager.ts";
import { mcpFetch, signInMcp } from "../../src/mcp/auth.ts";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import type { McpServerConfig } from "../../src/mcp/types.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { buildView } from "../../src/tui/views.ts";
import { initialState } from "../../src/tui/reducer.ts";
import { startFakeMcpOAuth } from "../fakes/fake-mcp-oauth.ts";

let env: ReturnType<typeof tmpEnv>, fake: ReturnType<typeof startFakeMcpOAuth>, manager: McpManager;
const cfg = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ name: "protected", type: "http", url: fake.url, source: "session", ...extra });
async function browser(url: string) {
  const response = await fetch(url, { redirect: "manual" }); expect(response.status).toBe(302);
  const callback = await fetch(response.headers.get("location")!); expect(callback.status).toBe(200);
}
async function connected() {
  for (let i = 0; i < 200 && manager.listServers().servers[0]?.status !== "connected"; i++) await Bun.sleep(5);
  expect(manager.listServers().servers[0]?.status).toBe("connected");
}
beforeEach(() => { env = tmpEnv(); fake = startFakeMcpOAuth(); manager = new McpManager(); setCredentialStore(new CredentialStore([new FileBackend()])); setAuthManager(new AuthManager()); });
afterEach(async () => { await manager.shutdown(); fake.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); });

test("MCP discovery, DCR exact callback, PKCE, refresh once, tool removal and sign-out", async () => {
  await manager.start([cfg()]);
  expect(manager.listServers().servers[0]).toMatchObject({ requiresAuth: true, hasAuthTokens: false, status: "failed" });
  expect(fake.registrations).toHaveLength(0);
  const login = await manager.signIn("protected");
  expect(login.name).toBe("protected");
  const url = new URL(login.url!);
  expect(url.searchParams.get("scope")).toBe("tools.read tools.call");
  expect(url.searchParams.get("resource")).toBe(fake.url);
  expect(fake.registrations[0].redirect_uris).toEqual([url.searchParams.get("redirect_uri")]);
  await browser(login.url!); await connected();
  expect(manager.loginStatus("protected", login.loginId).state).toBe("complete");
  expect(manager.listServers().servers[0]).toMatchObject({ requiresAuth: false, hasAuthTokens: true, toolCount: 4 });
  expect((await manager.callTool("protected__echo", { text: "authorized" })).text).toBe("authorized");
  // An out-of-band revocation of the current access token forces exactly one refresh.
  fake.oauth.issued++;
  expect((await manager.callTool("protected__echo", { text: "refreshed" })).text).toBe("refreshed");
  expect(fake.oauth.tokenRequests.filter((r) => r.form.grant_type === "refresh_token")).toHaveLength(1);
  fake.state.rejectTokens = true;
  let error: unknown;
  try { await manager.callTool("protected__echo", {}); } catch (e) { error = e; }
  expect((error as Error).message).toContain("authorization required");
  expect(fake.oauth.tokenRequests.filter((r) => r.form.grant_type === "refresh_token")).toHaveLength(2);
  expect(manager.tools()).toHaveLength(0);
  expect(manager.listServers().servers[0].requiresAuth).toBe(true);
  expect(await manager.signOut("protected")).toEqual({ loggedOut: true });
  expect(manager.listServers().servers[0].hasAuthTokens).toBe(false);
  expect(JSON.stringify(manager.listServers())).not.toContain("access-");
  expect(fake.oauth.tokenRequests.every((r) => r.form.resource === fake.url)).toBe(true);
});

test("pre-registered client, OIDC fallback, expiry refresh and URL-isolated credentials", async () => {
  fake.state.dcr = false; fake.state.oidcOnly = true; fake.state.expiresIn = 1;
  await manager.start([cfg({ oauth: { clientId: "owner-client" } })]);
  const login = await manager.signIn("protected"); await browser(login.url!); await connected();
  expect(fake.registrations).toHaveLength(0);
  expect(fake.oauth.tokenRequests[0].form.client_id).toBe("owner-client");
  expect(fake.oauth.tokenRequests.some((r) => r.form.grant_type === "refresh_token")).toBe(true);
  const other = startFakeMcpOAuth();
  try {
    let failed = false;
    try { await mcpFetch({ ...cfg(), url: other.url }, other.url, { method: "POST", body: "{}" }); } catch { failed = true; }
    expect(failed).toBe(true); expect(other.seen[0].token).toBeNull();
  } finally { other.stop(); }
});

test("invalid issuer, resource, PKCE and missing client registration fail closed", async () => {
  for (const field of ["issuerMatches", "resourceMatches", "pkce", "dcr"] as const) {
    fake.state[field] = false;
    // Capture a WWW-Authenticate challenge first so the resource-mismatch case uses its metadata URL.
    try { await mcpFetch(cfg(), fake.url, { method: "POST", body: "{}" }); } catch { /* requires sign-in */ }
    let error: unknown; try { await signInMcp(cfg()); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect(fake.registrations).toHaveLength(0);
    fake.state[field] = true;
  }
});

test("sign-in cancellation, server removal and cross-origin endpoints do not leak tokens", async () => {
  await manager.start([cfg()]);
  const login = await manager.signIn("protected");
  expect(manager.cancelLogin("protected", login.loginId)).toEqual({ cancelled: true });
  expect(manager.loginStatus("protected", login.loginId).state).toBe("cancelled");
  let hits = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return Response.json({}); } });
  try {
    let error: unknown; try { await mcpFetch(cfg(), `http://127.0.0.1:${trap.port}/trap`, {}); } catch (e) { error = e; }
    expect((error as Error).message).toContain("changed origin"); expect(hits).toBe(0);
  } finally { trap.stop(true); }
});

test("legacy SSE sends authorization on GET and POST, and refuses an off-origin endpoint", async () => {
  fake.state.legacy = true;
  await manager.start([cfg({ type: "sse" })]);
  const login = await manager.signIn("protected"); await browser(login.url!); await connected();
  expect((await manager.callTool("protected__echo", { text: "SSE" })).text).toBe("SSE");
  expect(fake.seen.some((r) => r.method === "GET" && r.token === "Bearer access-1")).toBe(true);
  expect(fake.seen.some((r) => r.method === "POST" && r.path === "/messages" && r.token === "Bearer access-1")).toBe(true);
  await manager.shutdown();
  fake.state.endpoint = "https://elsewhere.example/messages";
  await manager.start([cfg({ type: "sse" })]);
  expect(manager.listServers().servers[0]).toMatchObject({ status: "failed" });
  expect(manager.listServers().servers[0].error).toContain("changed origin");
});

test("/mcp shows sign-in state, opens the login URL, reports completion and signs out", async () => {
  await manager.start([cfg()]);
  let opened = "", completed = "";
  const context = { state: initialState({ cwd: env.root }), connection: "in-process", loginPollMs: 5, openUrl: (url: string) => { opened = url; }, notify: (text: string) => { completed = text; }, request: async (method: string, p: any) => {
    if (method === "list_mcp_servers") return manager.listServers();
    if (method === "mcp_sign_in") return manager.signIn(p.name);
    if (method === "mcp_sign_in_status") return manager.loginStatus(p.name, p.loginId);
    if (method === "mcp_sign_out") return manager.signOut(p.name);
    throw new Error("Unexpected method");
  } };
  expect((await buildView("mcp", "", context)).lines.join("\n")).toContain("needs sign-in: /mcp sign-in protected");
  const view = await buildView("mcp", "sign-in protected", context);
  expect(view.lines).toContain(opened); await browser(opened); await connected();
  for (let i = 0; i < 100 && !completed; i++) await Bun.sleep(5);
  expect(completed).toBe("Signed in to MCP server protected.");
  expect((await buildView("mcp", "sign-out protected", context)).lines[0]).toBe("Signed out of protected.");
});

test("a cancelled or removed login cannot reconnect the server, and redirects do not forward tokens", async () => {
  await manager.start([cfg()]);
  const login = await manager.signIn("protected");
  await manager.removeServer("protected");
  expect(manager.listServers().summary.total).toBe(0);
  const response = await fetch(login.url!, { redirect: "manual" });
  let callbackStatus = 0;
  try { callbackStatus = (await fetch(response.headers.get("location")!)).status; } catch { /* callback listener closed */ }
  expect(callbackStatus).not.toBe(200); expect(fake.oauth.issued).toBe(0);
  await manager.start([cfg()]);
  const next = await manager.signIn("protected"); await browser(next.url!); await connected();
  let hits = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return new Response(); } });
  try {
    fake.state.redirect = `http://127.0.0.1:${trap.port}/trap`;
    const result = await mcpFetch(cfg(), fake.url, { method: "POST", body: "{}" });
    expect(result.status).toBe(307); await result.body?.cancel(); expect(hits).toBe(0);
  } finally { trap.stop(true); }
});

test("sign-out during an in-flight refresh cannot restore a credential", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), started = new Promise<void>((r) => { entered = r; });
  setAuthManager(new AuthManager({ fetch: (async (url: any, init: any) => {
    if (new URLSearchParams(init?.body).get("grant_type") === "refresh_token") { entered(); await gate; }
    return fetch(url, init);
  }) as typeof fetch }));
  await manager.start([cfg()]);
  const login = await manager.signIn("protected"); await browser(login.url!); await connected();
  fake.oauth.issued++;
  const request = mcpFetch(cfg(), fake.url, { method: "POST", body: "{}" }).catch((e) => e);
  await started; await manager.signOut("protected"); release();
  expect((await request).message).toContain("authorization required");
  const keys = Object.keys(JSON.parse(readFileSync(join(env.rigwellHome, "credentials.json"), "utf8")));
  expect(keys.some((key) => key.startsWith("oauth:mcp-"))).toBe(false);
});

test("a token endpoint redirect cannot forward refresh credentials", async () => {
  await manager.start([cfg()]);
  const login = await manager.signIn("protected"); await browser(login.url!); await connected();
  let hits = 0;
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return Response.json({ error: "invalid_grant" }, { status: 400 }); } });
  try {
    fake.state.tokenRedirect = `http://127.0.0.1:${trap.port}/trap`; fake.oauth.issued++;
    try { await manager.callTool("protected__echo", {}); } catch { /* requires sign-in */ }
    expect(hits).toBe(0); expect(manager.listServers().servers[0].requiresAuth).toBe(true);
  } finally { trap.stop(true); }
});

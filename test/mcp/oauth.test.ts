// MCP OAuth sign-in against a local fake MCP server with its own authorization server. Never a real provider.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { McpManager, type McpServerConfig, type McpServerStatusInfo } from "../../src/mcp/index.ts";
import { canonicalResource, wwwAuthParams } from "../../src/mcp/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { startFakeMcpOAuth } from "../fakes/fake-mcp-oauth.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { inproc } from "../e2e/inproc.ts";
import { CLI } from "../e2e/helpers.ts";

let env: ReturnType<typeof tmpEnv>;
let proj: string;
let mgr: McpManager | undefined;
let clock = Date.now();
const stops: (() => void)[] = [];
beforeEach(() => {
  env = tmpEnv();
  proj = path.join(env.root, "proj");
  mkdirSync(path.join(proj, ".git"), { recursive: true });
  setCredentialStore(new CredentialStore([new FileBackend()]));
  clock = Date.now();
  setAuthManager(new AuthManager({ now: () => clock, loginTimeoutMs: 20_000 }));
});
afterEach(async () => {
  await mgr?.shutdown(); mgr = undefined;
  stops.splice(0).forEach((s) => s());
  setAuthManager(undefined); setCredentialStore(undefined); env.cleanup();
});

const fake = (o: Parameters<typeof startFakeMcpOAuth>[0] = {}) => { const f = startFakeMcpOAuth(o); stops.push(f.stop); return f; };
const http = (name: string, url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ name, type: "http", url, headers: {}, source: "session", ...extra });
const status = (name: string) => mgr!.listServers().servers.find((s) => s.name === name)!;
async function until(pred: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(10); }
}
/** Plays the browser: follows the authorize URL, then calls the loopback redirect. */
async function browser(url: string) {
  const r1 = await fetch(url, { redirect: "manual" });
  expect(r1.status).toBe(302);
  const r2 = await fetch(r1.headers.get("location")!);
  expect(r2.status).toBe(200);
  return r2;
}

test("WWW-Authenticate parameters and the canonical resource", () => {
  expect(wwwAuthParams(`Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="a b"`))
    .toEqual({ realm: "x", resource_metadata: "https://a.example/.well-known/oauth-protected-resource", scope: "a b" });
  expect(wwwAuthParams(`Bearer error=invalid_token`)).toEqual({ error: "invalid_token" });
  expect(wwwAuthParams(undefined)).toEqual({});
  expect(canonicalResource("https://MCP.Example.com/mcp/?x=1#f")).toBe("https://mcp.example.com/mcp");
  expect(canonicalResource("https://mcp.example.com/")).toBe("https://mcp.example.com");
});

test("a 401 server reports that sign-in is needed; nothing is registered before the user asks", async () => {
  const f = fake();
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("acme", f.url)]);
  expect(status("acme")).toMatchObject({ status: "failed", requiresAuth: true, hasAuthTokens: false });
  expect(status("acme").error).toContain("rigwell mcp login acme");
  expect(f.registrations).toBe(0);
  expect(mgr.tools()).toEqual([]);
});

test("sign-in: discovery, registration, PKCE with resource, reconnect with the token; logout and a second sign-in reuse the app", async () => {
  const f = fake();
  const changes: McpServerStatusInfo[] = [];
  mgr = new McpManager({ cwd: proj, onStatusChanged: (i) => changes.push(i) });
  await mgr.start([http("acme", f.url)]);

  const st = await mgr.login("acme");
  expect(st).toMatchObject({ state: "pending", kind: "browser", name: "mcp.acme" });
  expect(f.registrations).toBe(1);
  const authUrl = new URL(st.url!);
  expect(authUrl.origin).toBe(f.origin);
  expect(authUrl.searchParams.get("resource")).toBe(f.resource);
  expect(authUrl.searchParams.get("scope")).toBe("tools.read");
  expect(authUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  await browser(st.url!);
  await until(() => status("acme").status === "connected");
  expect(status("acme")).toMatchObject({ requiresAuth: false, hasAuthTokens: true, toolCount: 4 });
  expect((await mgr.callTool("acme__echo", { text: "hi" })).text).toBe("hi");
  expect(f.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", resource: f.resource, client_id: "client-1" });
  expect(f.tokenRequests[0]!.code_verifier).toBeTruthy();
  expect(f.mcpAuth.at(-1)).toBe("Bearer mcp-access-1");
  expect(changes.map((c) => c.status)).toContain("connected");

  // Logout: the token goes, the server asks for sign-in again.
  expect(await mgr.logout("acme")).toEqual({ success: true });
  expect(status("acme")).toMatchObject({ status: "failed", requiresAuth: true, hasAuthTokens: false });

  // A second sign-in reuses the registered app.
  const st2 = await mgr.login("acme");
  expect(f.registrations).toBe(1);
  await browser(st2.url!);
  await until(() => status("acme").status === "connected");
  expect(f.mcpAuth.at(-1)).toBe("Bearer mcp-access-2");
});

test("an expired token is refreshed with the resource before the request", async () => {
  const f = fake();
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("acme", f.url)]);
  await browser((await mgr.login("acme")).url!);
  await until(() => status("acme").status === "connected");
  clock += 2 * 3600_000; // past expiry for the client; the fake still takes the old token, so only a refresh proves anything
  expect((await mgr.callTool("acme__echo", { text: "later" })).text).toBe("later");
  const r = f.tokenRequests.find((t) => t.grant_type === "refresh_token");
  expect(r).toMatchObject({ refresh_token: "mcp-refresh-1", resource: f.resource });
  expect(f.mcpAuth.at(-1)).toBe("Bearer mcp-access-2");
});

test("no resource_metadata in the 401: the well-known path is found", async () => {
  const f = fake({ headerHint: false });
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("acme", f.url)]);
  await browser((await mgr.login("acme")).url!);
  await until(() => status("acme").status === "connected");
});

test("no registration endpoint: a clear error, and oauth.clientId works without registering", async () => {
  const f = fake({ registration: false, staticClient: "my-app" });
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("plain", f.url), http("withid", f.url, { oauth: { clientId: "my-app" } })]);
  await expect(mgr.login("plain")).rejects.toThrow(/does not register apps automatically.*oauth\.clientId/);
  const st = await mgr.login("withid");
  expect(new URL(st.url!).searchParams.get("client_id")).toBe("my-app");
  await browser(st.url!);
  await until(() => status("withid").status === "connected");
  expect(f.registrations).toBe(0);
});

test("oauth: false and an Authorization header turn OAuth off", async () => {
  const f = fake();
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("off", f.url, { oauth: false }), http("hdr", f.url, { headers: { Authorization: "Bearer wrong" } })]);
  for (const n of ["off", "hdr"]) {
    const s = status(n);
    expect(s.status).toBe("failed");
    expect(s.error).toContain("HTTP 401");
    expect(s.requiresAuth).toBeUndefined();
    await expect(mgr.login(n)).rejects.toThrow(/OAuth is off/);
  }
  expect(f.registrations).toBe(0);
});

test("legacy SSE server with OAuth", async () => {
  const f = fake({ mode: "legacy" });
  mgr = new McpManager({ cwd: proj });
  await mgr.start([http("old", f.url, { type: "sse" })]);
  expect(status("old")).toMatchObject({ status: "failed", requiresAuth: true });
  await browser((await mgr.login("old")).url!);
  await until(() => status("old").status === "connected");
  expect((await mgr.callTool("old__echo", { text: "S" })).text).toBe("S");
});

test("protocol: mcp_auth_start, auth_login_status, mcp_auth_logout; no token in any result", async () => {
  const f = fake();
  writeFileSync(path.join(env.rigwellHome, "settings.json"), JSON.stringify({
    customModels: [{ model: "fake-model", displayName: "Fake", provider: "anthropic", baseUrl: "http://127.0.0.1:1", apiKey: "test-key-not-real" }],
  }));
  const c = inproc();
  const seen: string[] = [];
  const call = async (m: string, p: Record<string, unknown> = {}) => { const r = await c.call(m, p); seen.push(JSON.stringify(r)); return r; };
  await call("initialize_session", { machineId: "default", cwd: proj, modelId: "custom:Fake-0", mcpServers: [{ type: "http", name: "acme", url: f.url, headers: [] }] });
  const list = async () => (await call("list_mcp_servers")).servers.find((s: any) => s.name === "acme");
  await until(() => c.notes().some((n: any) => n.type === "mcp_status_changed" && n.server?.status === "failed"));
  expect(await list()).toMatchObject({ status: "failed", requiresAuth: true, hasAuthTokens: false });
  await expect(c.call("mcp_auth_start", {})).rejects.toThrow(/serverName is required/);
  await expect(c.call("mcp_auth_start", { serverName: "nope" })).rejects.toThrow(/No MCP server named/);

  const st = await call("mcp_auth_start", { serverName: "acme" });
  expect(st.state).toBe("pending");
  await browser(st.url);
  expect((await call("auth_login_status", { loginId: st.loginId })).state).toBe("complete");
  await until(() => c.notes().some((n: any) => n.type === "mcp_status_changed" && n.server?.name === "acme" && n.server?.status === "connected"));
  expect(await list()).toMatchObject({ status: "connected", hasAuthTokens: true, requiresAuth: false });

  expect(await call("mcp_auth_logout", { serverName: "acme" })).toEqual({ success: true });
  expect(await list()).toMatchObject({ status: "failed", requiresAuth: true, hasAuthTokens: false });
  expect(seen.join("\n")).not.toMatch(/mcp-access-|mcp-refresh-/);
  await call("close_session", { reason: "other" });
}, 30_000);

test("cli: rigwell mcp login prints the URL, waits for the redirect, and status shows the sign-in", async () => {
  const f = fake();
  writeFileSync(path.join(env.rigwellHome, "mcp.json"), JSON.stringify({ mcpServers: { acme: { type: "http", url: f.url } } }));
  const cliEnv = { ...process.env, RIGWELL_HOME: env.rigwellHome, RIGWELL_CREDENTIALS: "file" };
  const p = Bun.spawn(["bun", CLI, "mcp", "login", "acme"], { cwd: proj, env: cliEnv, stdout: "pipe", stderr: "pipe" });
  const reader = p.stderr.getReader();
  const dec = new TextDecoder();
  let err = "";
  let url: string | undefined;
  while (!url) {
    const { done, value } = await reader.read();
    if (done) break;
    err += dec.decode(value);
    url = err.match(/^\s+(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)$/m)?.[1];
  }
  expect(url).toBeTruthy();
  await browser(url!);
  for (;;) { const { done, value } = await reader.read(); if (done) break; err += dec.decode(value); }
  expect(await p.exited).toBe(0);
  expect(err).toContain("signed in to acme");

  const s = Bun.spawn(["bun", CLI, "mcp", "status"], { cwd: proj, env: cliEnv, stdout: "pipe", stderr: "pipe" });
  expect(await s.exited).toBe(0);
  expect(await new Response(s.stderr).text()).toContain("acme: signed in");
}, 30_000);

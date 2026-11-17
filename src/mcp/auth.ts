// Remote MCP authorization: resource/issuer discovery, PKCE registration and URL-bound credentials.
import { createHash } from "node:crypto";
import { mcpSecret } from "./catalog.ts";
import { authManager, loadToken, type LoginStatus } from "../auth/oauth.ts";
import { parseOAuthProviders, secureUrl, type OAuthProviderConfig } from "../auth/config.ts";
import { lookupCredential, removeCredential, storeCredential } from "../storage/credentials.ts";
import type { McpServerConfig } from "./types.ts";

export class McpAuthRequired extends Error {
  constructor(message = "MCP authorization required: sign in to this server") { super(message); this.name = "McpAuthRequired"; }
}
type ObjectValue = Record<string, any>;
interface Registration { binding: string; issuer: string; provider: OAuthProviderConfig }
const challenges = new Map<string, { metadata?: string; scope?: string }>();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function safeUrl(value: unknown): string {
  if (!secureUrl(value)) throw new Error("MCP authorization requires HTTPS (HTTP is allowed only on loopback)");
  const u = new URL(value);
  if (u.username || u.password || u.hash) throw new Error("MCP authorization URL must not contain credentials or a fragment");
  return u.toString();
}
export function mcpResource(cfg: McpServerConfig): string {
  const u = new URL(safeUrl(cfg.url));
  return u.pathname === "/" && !u.search ? u.origin : u.toString();
}
function identity(cfg: McpServerConfig) { return `mcp-${hash(mcpResource(cfg)).slice(0, 48)}`; }
function binding(cfg: McpServerConfig) { return hash(JSON.stringify(cfg.oauth ?? {})); }
function key(cfg: McpServerConfig) { return `mcp-registration:${identity(cfg)}`; }
function registration(cfg: McpServerConfig): Registration | undefined {
  if (cfg.type === "stdio" || cfg.oauth === false) return;
  try {
    const r = JSON.parse(lookupCredential(key(cfg)) ?? "null") as Registration | null;
    if (r?.binding === binding(cfg) && r.provider.name === identity(cfg) && r.provider.resource === mcpResource(cfg)) return r;
  } catch { /* Missing or invalid private metadata requires sign-in again. */ }
}
export function hasMcpTokens(cfg: McpServerConfig): boolean { const r = registration(cfg); return !!r && !!loadToken(r.provider.name); }

async function json(url: string, init?: RequestInit): Promise<ObjectValue> {
  const res = await fetch(safeUrl(url), { ...init, headers: { accept: "application/json", ...init?.headers }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`MCP metadata request failed (HTTP ${res.status})`); }
  const body = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid MCP authorization metadata");
  return body;
}
function challenge(cfg: McpServerConfig, res: Response) {
  const text = res.headers.get("www-authenticate") ?? "";
  const param = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, "i").exec(text)?.[1];
  challenges.set(mcpResource(cfg), { metadata: param("resource_metadata"), scope: param("scope") });
}

/** Every HTTP leg uses the same token policy. Redirects never forward credentials. */
export async function mcpFetch(cfg: McpServerConfig, url: string, init: RequestInit, refresh = true): Promise<Response> {
  if (new URL(url).origin !== new URL(cfg.url!).origin) throw new Error("MCP endpoint changed origin; credentials were not sent");
  const r = registration(cfg);
  let token: string | undefined;
  if (r && loadToken(r.provider.name)) {
    try { token = refresh ? await authManager().accessToken(r.provider) : loadToken(r.provider.name)?.accessToken; }
    catch { throw new McpAuthRequired(); }
  }
  const send = () => {
    const headers = new Headers(init.headers);
    for (const [key, value] of headers) if (value.startsWith("keychain:")) headers.set(key, mcpSecret(value));
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers, redirect: "manual" });
  };
  let res = await send();
  if (res.status === 401 && token && r && refresh) {
    challenge(cfg, res); await res.body?.cancel();
    try { token = await authManager().refreshRejected(r.provider, token); }
    catch { throw new McpAuthRequired(); }
    res = await send();
  }
  if (res.status === 401 || res.status === 403) {
    challenge(cfg, res); await res.body?.cancel();
    throw new McpAuthRequired(cfg.oauth === false ? "MCP authorization required: OAuth is disabled; configure headers" : undefined);
  }
  return res;
}

async function discover(cfg: McpServerConfig) {
  const resource = mcpResource(cfg), u = new URL(resource);
  const hint = challenges.get(resource);
  const resourceUrls = hint?.metadata ? [safeUrl(hint.metadata)] : [...new Set([
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ])];
  let prm: ObjectValue | undefined;
  for (const url of resourceUrls) { try { prm = await json(url); break; } catch (e) { if (hint?.metadata) throw e; } }
  if (!prm) throw new Error("MCP protected resource metadata is unavailable");
  if (typeof prm.resource !== "string" || mcpResource({ ...cfg, url: prm.resource }) !== resource) throw new Error("MCP resource metadata does not match this server URL");
  const issuers = prm.authorization_servers;
  if (!Array.isArray(issuers) || !issuers.length || typeof issuers[0] !== "string") throw new Error("MCP resource metadata has no authorization server");
  const issuer = safeUrl(issuers[0]), a = new URL(issuer), path = a.pathname === "/" ? "" : a.pathname.replace(/\/$/, "");
  const urls = [...new Set([`${a.origin}/.well-known/oauth-authorization-server${path}`, `${a.origin}/.well-known/openid-configuration${path}`, `${a.origin}${path}/.well-known/openid-configuration`])];
  let metadata: ObjectValue | undefined;
  for (const url of urls) { try { metadata = await json(url); break; } catch { /* Try the next standards-defined discovery location. */ } }
  if (!metadata || typeof metadata.issuer !== "string" || safeUrl(metadata.issuer) !== issuer) throw new Error("MCP authorization server issuer is missing or does not match");
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) throw new Error("MCP authorization server must support PKCE S256");
  safeUrl(metadata.authorization_endpoint); safeUrl(metadata.token_endpoint);
  const scopes = hint?.scope?.split(/\s+/).filter(Boolean) ?? (Array.isArray(prm.scopes_supported) ? prm.scopes_supported : []);
  if (scopes.some((v: unknown) => typeof v !== "string" || /\s/.test(v))) throw new Error("Invalid MCP scopes");
  return { resource, metadata, scopes };
}

export async function signInMcp(cfg: McpServerConfig): Promise<LoginStatus> {
  if (cfg.type === "stdio" || cfg.oauth === false) throw new Error("OAuth is unavailable for this MCP server");
  const { resource, metadata, scopes } = await discover(cfg);
  const own = cfg.oauth ?? {}, previous = registration(cfg);
  const raw = {
    ...own, clientId: typeof own.clientId === "string" ? own.clientId : "pending-registration",
    authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint,
    scopes, redirectPath: "/mcp-callback",
    ...(previous && !own.clientId ? { redirectPort: previous.provider.redirectPort } : {}),
  };
  const parsed = parseOAuthProviders({ [identity(cfg)]: raw });
  const provider = parsed.providers.get(identity(cfg));
  if (!provider) throw new Error(parsed.problems.join("; "));
  provider.resource = resource;
  const register = !own.clientId;
  if (register && !metadata.registration_endpoint) throw new Error("MCP server has no client registration endpoint; configure oauth.clientId");
  return authManager().loginStart(provider, "browser", async (redirectUri) => {
    if (register) {
      // Reuse a registration only for the same discovered issuer/endpoints and exact redirect URI.
      if (previous && previous.issuer === metadata.issuer && previous.provider.authorizationEndpoint === provider.authorizationEndpoint && previous.provider.tokenEndpoint === provider.tokenEndpoint && previous.provider.redirectPort === Number(new URL(redirectUri).port)) {
        provider.clientId = previous.provider.clientId; provider.clientSecret = previous.provider.clientSecret; provider.tokenAuthMethod = previous.provider.tokenAuthMethod;
      } else {
        const result = await json(safeUrl(metadata.registration_endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Rigwell", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
        if (typeof result.client_id !== "string" || !result.client_id || result.token_endpoint_auth_method && result.token_endpoint_auth_method !== "none") throw new Error("Unsupported MCP client registration response");
        if (result.redirect_uris && (!Array.isArray(result.redirect_uris) || !result.redirect_uris.includes(redirectUri))) throw new Error("MCP registration did not accept the loopback redirect");
        provider.clientId = result.client_id;
        provider.tokenAuthMethod = "none";
      }
    }
    // A token from a changed client/issuer must never be sent under the new registration.
    if (!previous || previous.issuer !== metadata.issuer || previous.provider.clientId !== provider.clientId || previous.provider.tokenEndpoint !== provider.tokenEndpoint || previous.provider.authorizationEndpoint !== provider.authorizationEndpoint) authManager().logout(provider.name);
    provider.redirectPort = Number(new URL(redirectUri).port);
    storeCredential(key(cfg), JSON.stringify({ binding: binding(cfg), issuer: metadata.issuer, provider } satisfies Registration));
  });
}

export function signOutMcp(cfg: McpServerConfig): boolean {
  if (cfg.type === "stdio") return false;
  const removed = authManager().logout(identity(cfg));
  removeCredential(key(cfg)); challenges.delete(mcpResource(cfg));
  return removed;
}

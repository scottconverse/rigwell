// OAuth sign-in for http and sse MCP servers (MCP authorization, protocol 2025-06-18).
// Discovery: protected resource metadata (RFC 9728), then authorization server metadata (RFC 8414, or OpenID discovery).
// Client: `oauth.clientId` from mcp.json, a client metadata document URL, or dynamic client registration (RFC 7591).
// Every request names the MCP server as the RFC 8707 `resource`. The browser sign-in (PKCE over a 127.0.0.1 redirect),
// refresh and token storage reuse the generic AuthManager (src/auth/oauth.ts). Tokens live in the credential store.
import { secureUrl, type OAuthProviderConfig } from "../auth/config.ts";
import { AuthError, authManager, loadToken, type LoginStatus } from "../auth/oauth.ts";
import { lookupCredential, removeCredential, storeCredential } from "../storage/credentials.ts";
import type { McpServerConfig } from "./types.ts";

/** The server answered 401: the user must sign in (`rigwell mcp login <name>` or `mcp_auth_start`). */
export class McpAuthRequiredError extends Error {
  constructor(readonly server: string, readonly wwwAuthenticate?: string, why = "Sign-in needed") {
    super(`${why}: run \`rigwell mcp login ${server}\``);
    this.name = "McpAuthRequiredError";
  }
}

/** The options of `oauth` in mcp.json / add_mcp_server (spec 3.1.5). */
export interface McpOAuthOptions {
  scopes?: string[];
  resource?: string;
  authorizationServerIssuer?: string;
  clientMetadataUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/** What discovery and registration found; saved so a refresh needs no network discovery. */
interface McpAuthRecord {
  url: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scopes: string[];
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod: OAuthProviderConfig["tokenAuthMethod"];
  /** Set for a registered client: the port in its registered redirect URI. */
  redirectPort?: number;
  /** true: Rigwell registered this client itself. */
  registered?: boolean;
}

/** AuthManager name of a server's sign-in. The token is stored under `oauth:mcp.<server>`. */
export const mcpAuthName = (server: string) => `mcp.${server}`;
const recordKey = (server: string) => `mcp-oauth:${server}`;
const REDIRECT_PATH = "/callback";

const hasAuthHeader = (h?: Record<string, string>) => Object.keys(h ?? {}).some((k) => k.toLowerCase() === "authorization");

/** OAuth applies to http and sse servers unless `oauth: false` or the config already sends an Authorization header. */
export function oauthEnabled(cfg: McpServerConfig): boolean {
  return cfg.type !== "stdio" && cfg.oauth !== false && !hasAuthHeader(cfg.headers);
}

export function oauthOptions(cfg: McpServerConfig): McpOAuthOptions {
  const o = cfg.oauth && typeof cfg.oauth === "object" ? cfg.oauth : {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string" && !!s) : undefined;
  return {
    ...(scopes ? { scopes } : {}),
    ...(str(o.resource) ? { resource: str(o.resource) } : {}),
    ...(str(o.authorizationServerIssuer) ? { authorizationServerIssuer: str(o.authorizationServerIssuer) } : {}),
    ...(str(o.clientMetadataUrl) ? { clientMetadataUrl: str(o.clientMetadataUrl) } : {}),
    ...(str(o.clientId) ? { clientId: str(o.clientId) } : {}),
    ...(str(o.clientSecret) ? { clientSecret: str(o.clientSecret) } : {}),
  };
}

/** Parameters of a `WWW-Authenticate: Bearer k="v", ...` header. */
export function wwwAuthParams(h?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const m of h.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  return out;
}

/** The canonical URI of the server for `resource`: scheme, host and path, without query, fragment or a trailing "/". */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${p}`;
}

function loadRecord(cfg: McpServerConfig): McpAuthRecord | undefined {
  const raw = lookupCredential(recordKey(cfg.name));
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as McpAuthRecord;
    return r && r.url === cfg.url && typeof r.clientId === "string" ? r : undefined; // the server moved: discover again
  } catch { return undefined; }
}

function providerFor(cfg: McpServerConfig, r: McpAuthRecord): OAuthProviderConfig {
  return {
    name: mcpAuthName(cfg.name), clientId: r.clientId, ...(r.clientSecret !== undefined ? { clientSecret: r.clientSecret } : {}),
    tokenAuthMethod: r.tokenAuthMethod, authorizationEndpoint: r.authorizationEndpoint, tokenEndpoint: r.tokenEndpoint,
    scopes: r.scopes, ...(r.redirectPort ? { redirectPort: r.redirectPort } : {}), redirectPath: REDIRECT_PATH,
    authParams: { resource: r.resource }, tokenParams: { resource: r.resource }, tokenHeader: "authorization", tokenScheme: "Bearer",
  };
}

/** True when a sign-in token is stored for this server. */
export function mcpHasToken(cfg: McpServerConfig): boolean {
  return oauthEnabled(cfg) && !!loadToken(mcpAuthName(cfg.name)) && !!loadRecord(cfg);
}

/**
 * The Authorization header for a request to this server: empty when OAuth does not apply or nobody signed in yet.
 * A token near expiry is refreshed first; a refresh that fails means the user must sign in again.
 */
export async function mcpAuthHeaders(cfg: McpServerConfig): Promise<Record<string, string>> {
  if (!oauthEnabled(cfg) || !loadToken(mcpAuthName(cfg.name))) return {};
  const r = loadRecord(cfg);
  if (!r) return {};
  try { return await authManager().headers(providerFor(cfg, r)); } catch (e) {
    if (e instanceof AuthError && (e.code === "expired" || e.code === "not_logged_in")) throw new McpAuthRequiredError(cfg.name, undefined, "The sign-in expired");
    throw e;
  }
}

// ---------------------------------------------------------------- discovery

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<Record<string, any> | undefined> {
  try {
    const res = await f(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { void res.body?.cancel(); return undefined; }
    const j = await res.json();
    return j && typeof j === "object" && !Array.isArray(j) ? j : undefined;
  } catch { return undefined; }
}

/** Ask the server once without a token, to read its WWW-Authenticate header. */
async function probe(cfg: McpServerConfig, f: Fetch): Promise<string | undefined> {
  try {
    const res = cfg.type === "sse"
      ? await f(cfg.url!, { headers: { accept: "text/event-stream", ...(cfg.headers ?? {}) }, signal: AbortSignal.timeout(15_000) })
      : await f(cfg.url!, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(cfg.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rigwell", version: "0.1.0" } } }),
      });
    void res.body?.cancel();
    return res.status === 401 ? res.headers.get("www-authenticate") ?? undefined : undefined;
  } catch { return undefined; }
}

interface Discovered { issuer: string; meta: Record<string, any>; resource: string; scopes: string[] }

async function discover(cfg: McpServerConfig, o: McpOAuthOptions, wwwAuthenticate: string | undefined, f: Fetch): Promise<Discovered> {
  const server = new URL(cfg.url!);
  const params = wwwAuthParams(wwwAuthenticate);
  // 1. Protected resource metadata: the URL in the 401 header first, then the well-known paths.
  const prmUrls: string[] = [];
  if (secureUrl(params.resource_metadata)) prmUrls.push(params.resource_metadata);
  const path = server.pathname.replace(/\/+$/, "");
  if (path) prmUrls.push(`${server.origin}/.well-known/oauth-protected-resource${path}`);
  prmUrls.push(`${server.origin}/.well-known/oauth-protected-resource`);
  let prm: Record<string, any> | undefined;
  for (const u of prmUrls) { prm = await getJson(f, u); if (prm && Array.isArray(prm.authorization_servers)) break; prm = undefined; }

  const issuer = o.authorizationServerIssuer ?? (typeof prm?.authorization_servers?.[0] === "string" ? prm.authorization_servers[0] : undefined);
  if (!issuer) throw new AuthError("unsupported", `The MCP server "${cfg.name}" does not publish its sign-in settings (no protected resource metadata). Set headers, or oauth.authorizationServerIssuer in mcp.json.`);
  if (!secureUrl(issuer)) throw new AuthError("unsupported", `The sign-in server of "${cfg.name}" must use https: ${issuer}`);

  // 2. Authorization server metadata (RFC 8414), then OpenID discovery.
  const iu = new URL(issuer);
  const ip = iu.pathname.replace(/\/+$/, "");
  const asUrls = ip
    ? [`${iu.origin}/.well-known/oauth-authorization-server${ip}`, `${iu.origin}/.well-known/openid-configuration${ip}`, `${iu.origin}${ip}/.well-known/openid-configuration`]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
  let meta: Record<string, any> | undefined;
  for (const u of asUrls) { meta = await getJson(f, u); if (meta && typeof meta.token_endpoint === "string") break; meta = undefined; }
  if (!meta) throw new AuthError("unsupported", `Could not read the sign-in server settings of "${cfg.name}" at ${issuer}`);
  for (const k of ["authorization_endpoint", "token_endpoint"]) {
    if (!secureUrl(meta[k])) throw new AuthError("unsupported", `The sign-in server of "${cfg.name}" has no usable ${k} (https is required)`);
  }
  if (meta.registration_endpoint !== undefined && !secureUrl(meta.registration_endpoint)) delete meta.registration_endpoint;
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new AuthError("unsupported", `The sign-in server of "${cfg.name}" does not support PKCE with S256`);

  const fromHeader = params.scope ? params.scope.split(/\s+/).filter(Boolean) : undefined;
  const fromPrm = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((s: unknown): s is string => typeof s === "string") : undefined;
  return {
    issuer, meta,
    resource: o.resource ?? (typeof prm?.resource === "string" && prm.resource ? prm.resource : canonicalResource(cfg.url!)),
    scopes: o.scopes ?? fromHeader ?? fromPrm ?? [],
  };
}

/** A free port on 127.0.0.1 for the redirect URI that a registration names. */
function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = s.port!;
  void s.stop(true);
  return port;
}

async function register(cfg: McpServerConfig, d: Discovered, f: Fetch): Promise<Pick<McpAuthRecord, "clientId" | "clientSecret" | "tokenAuthMethod" | "redirectPort">> {
  const endpoint = d.meta.registration_endpoint as string | undefined;
  if (!endpoint) throw new AuthError("unsupported", `The sign-in server of "${cfg.name}" does not register apps automatically. Register an app with it and set oauth.clientId in mcp.json.`);
  const port = freePort();
  let res: Response;
  try {
    res = await f(endpoint, {
      method: "POST", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Rigwell", redirect_uris: [`http://127.0.0.1:${port}${REDIRECT_PATH}`], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none", ...(d.scopes.length ? { scope: d.scopes.join(" ") } : {}),
      }),
    });
  } catch (e) {
    throw new AuthError("failed", `Could not reach the registration endpoint of "${cfg.name}": ${(e as Error)?.message ?? e}`);
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.client_id !== "string" || !j.client_id) {
    throw new AuthError("failed", `App registration with the sign-in server of "${cfg.name}" failed: ${typeof j.error === "string" ? j.error : `http_${res.status}`}`);
  }
  const secret = typeof j.client_secret === "string" && j.client_secret ? j.client_secret : undefined;
  const method = j.token_endpoint_auth_method === "client_secret_basic" && secret ? "client_secret_basic" : secret ? "client_secret_post" : "none";
  return { clientId: j.client_id, ...(secret ? { clientSecret: secret } : {}), tokenAuthMethod: method, redirectPort: port };
}

/** Discover, pick or register a client, and save the record. Reuses a saved registration for the same server and issuer. */
async function resolve(cfg: McpServerConfig, wwwAuthenticate: string | undefined, f: Fetch): Promise<McpAuthRecord> {
  const o = oauthOptions(cfg);
  const d = await discover(cfg, o, wwwAuthenticate ?? await probe(cfg, f), f);
  const base = { url: cfg.url!, issuer: d.issuer, authorizationEndpoint: d.meta.authorization_endpoint, tokenEndpoint: d.meta.token_endpoint, resource: d.resource, scopes: d.scopes };
  let rec: McpAuthRecord;
  if (o.clientId) {
    rec = { ...base, clientId: o.clientId, ...(o.clientSecret ? { clientSecret: o.clientSecret } : {}), tokenAuthMethod: o.clientSecret ? "client_secret_post" : "none" };
  } else if (o.clientMetadataUrl && d.meta.client_id_metadata_document_supported === true) {
    if (!secureUrl(o.clientMetadataUrl)) throw new AuthError("unsupported", "oauth.clientMetadataUrl must be an https URL");
    rec = { ...base, clientId: o.clientMetadataUrl, tokenAuthMethod: "none" };
  } else {
    const old = loadRecord(cfg);
    const reuse = old?.registered && old.issuer === d.issuer ? old : undefined;
    rec = { ...base, ...(reuse ? { clientId: reuse.clientId, ...(reuse.clientSecret ? { clientSecret: reuse.clientSecret } : {}), tokenAuthMethod: reuse.tokenAuthMethod, redirectPort: reuse.redirectPort } : await register(cfg, d, f)), registered: true };
  }
  storeCredential(recordKey(cfg.name), JSON.stringify(rec));
  return rec;
}

/** Start the browser sign-in for an MCP server. The caller shows `url` and polls the login (or waits on it). */
export async function mcpLoginStart(cfg: McpServerConfig, opts: { wwwAuthenticate?: string; fetch?: Fetch } = {}): Promise<LoginStatus> {
  if (cfg.type === "stdio") throw new AuthError("unsupported", `"${cfg.name}" is a stdio server: OAuth sign-in is for http and sse servers`);
  if (!oauthEnabled(cfg)) throw new AuthError("unsupported", `OAuth is off for "${cfg.name}" (oauth is false, or headers set an Authorization header)`);
  const rec = await resolve(cfg, opts.wwwAuthenticate, opts.fetch ?? fetch);
  const mgr = authManager();
  const busy = (e: unknown) => rec.registered && /port|EADDRINUSE|address/i.test((e as Error).message);
  try { return await mgr.loginStart(providerFor(cfg, rec), "browser"); } catch (e) {
    if (!busy(e)) throw e;
    // The last sign-in's redirect server closes a moment after it answers: try the same port once more.
    await Bun.sleep(500);
    try { return await mgr.loginStart(providerFor(cfg, rec), "browser"); } catch (e2) { e = e2; }
    // The saved redirect port is taken by another program: register a fresh client once.
    if (busy(e)) {
      removeCredential(recordKey(cfg.name));
      const again = await resolve(cfg, opts.wwwAuthenticate, opts.fetch ?? fetch);
      return mgr.loginStart(providerFor(cfg, again), "browser");
    }
    throw e;
  }
}

/** Remove the stored token. The app registration stays, so the next sign-in skips it. */
export function mcpLogout(server: string): boolean {
  return authManager().logout(mcpAuthName(server));
}

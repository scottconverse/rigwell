// Code-host connections share the normal credential store and registered OAuth clients.
import { lookupCredential, removeCredential, storeCredential } from "../storage/credentials.ts";
import { loadSettings, type RigwellSettings } from "../storage/settings.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { parseOAuthProviders } from "./config.ts";
import { authManager, loadToken } from "./oauth.ts";

export type CodeProvider = "github" | "gitlab";
const providers: CodeProvider[] = ["github", "gitlab"];
export interface CodeProviderDeps {
  fetch?: typeof fetch;
  /** Test seam, never accepted from protocol input. */
  apiRoot?: (provider: CodeProvider) => string;
}
export interface CodeConnection {
  provider: CodeProvider;
  connected: boolean;
  deviceLogin: boolean;
  source?: "token" | "oauth";
  account?: string;
  scopes?: string[];
  error?: string;
}
const config = (provider: CodeProvider, settings: RigwellSettings) => parseOAuthProviders(settings.oauthProviders).providers.get(provider);

/** Shared by PR creation and later code-host features; refresh OAuth before use. */
export async function codeProviderToken(provider: CodeProvider, settings: RigwellSettings = loadSettings({ cwd: process.cwd() }).settings): Promise<string | undefined> {
  const token = lookupCredential(provider);
  if (token) return token;
  const cfg = config(provider, settings);
  if (cfg && loadToken(provider)) return authManager().accessToken(cfg);
  return undefined;
}

async function inspect(provider: CodeProvider, token: string, source: "token" | "oauth", deps: CodeProviderDeps) {
  const root = deps.apiRoot?.(provider) ?? (provider === "github" ? "https://api.github.com" : "https://gitlab.com");
  const get = async (route: string) => {
    try { return await (deps.fetch ?? fetch)(root + route, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" }); }
    catch { throw new Error(`Could not reach ${provider}`); }
  };
  const response = await get(provider === "github" ? "/user" : "/api/v4/user");
  if (!response.ok) throw new Error(`${provider} account verification returned HTTP ${response.status}`);
  let user: any;
  try { user = await response.json(); } catch { throw new Error(`${provider} returned an invalid account response`); }
  const account = provider === "github" ? user.login : user.username;
  if (typeof account !== "string" || !account) throw new Error(`${provider} did not identify the signed-in account`);
  let scopes: string[] | undefined;
  if (provider === "github") {
    const header = response.headers.get("x-oauth-scopes");
    if (header !== null) scopes = header.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    // PATs and OAuth tokens expose scope metadata at different endpoints.
    const meta = await get(source === "oauth" ? "/oauth/token/info" : "/api/v4/personal_access_tokens/self").catch(() => undefined);
    if (meta?.ok) {
      const body: any = await meta.json().catch(() => ({}));
      const values = body.scopes ?? body.scope;
      if (Array.isArray(values) && values.every((s) => typeof s === "string")) scopes = values;
    }
  }
  return { account, ...(scopes === undefined ? {} : { scopes }) };
}

async function connection(provider: CodeProvider, settings: RigwellSettings, deps: CodeProviderDeps): Promise<CodeConnection> {
  const base = { provider, deviceLogin: !!config(provider, settings)?.deviceAuthorizationEndpoint };
  const source = lookupCredential(provider) ? "token" : loadToken(provider) ? "oauth" : undefined;
  if (!source) return { ...base, connected: false };
  try {
    const token = await codeProviderToken(provider, settings);
    if (!token) throw new Error(`Restore oauthProviders.${provider} to use the saved OAuth connection`);
    return { ...base, connected: true, source, ...await inspect(provider, token, source, deps) };
  } catch (error) { return { ...base, connected: false, source, error: (error as Error).message }; }
}

export async function handleCodeProviderMethod(method: string, params: Record<string, unknown>, settings: () => RigwellSettings, deps: CodeProviderDeps = {}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!["code_provider_list", "code_provider_connect", "code_provider_disconnect", "code_provider_login_start", "code_provider_login_status", "code_provider_login_cancel"].includes(method)) return { handled: false };
  const ok = (result: unknown) => ({ handled: true as const, result });
  if (method === "code_provider_list") return ok({ connections: await Promise.all(providers.map((p) => connection(p, settings(), deps))) });
  const provider = params.provider as CodeProvider;
  if (!providers.includes(provider)) throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider must be github or gitlab");
  if (method === "code_provider_disconnect") {
    authManager().logout(provider); removeCredential(provider);
    return ok({ disconnected: true });
  }
  if (method === "code_provider_connect") {
    if (typeof params.token !== "string" || !params.token.trim() || /\s/.test(params.token.trim()) || params.token.length > 16384) throw new RpcError(ErrorCodes.INVALID_PARAMS, "Enter a nonempty token without whitespace");
    const token = params.token.trim();
    const identity = await inspect(provider, token, "token", deps);
    storeCredential(provider, token); authManager().logout(provider);
    return ok({ provider, connected: true, source: "token", deviceLogin: !!config(provider, settings())?.deviceAuthorizationEndpoint, ...identity });
  }
  const cfg = config(provider, settings());
  if (!cfg?.deviceAuthorizationEndpoint) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Configure oauthProviders.${provider} with Rigwell's registered client ID and device endpoints first (docs/auth.md)`);
  if (method === "code_provider_login_start") return ok(await authManager().loginStart(cfg, "device"));
  const status = typeof params.loginId === "string" ? authManager().loginStatus(params.loginId) : undefined;
  if (!status || status.name !== provider) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, "Unknown code-provider login");
  if (method === "code_provider_login_cancel") return ok({ cancelled: authManager().cancelLogin(status.loginId) });
  if (status.state !== "complete") return ok(status);
  const token = await authManager().accessToken(cfg);
  const identity = await inspect(provider, token, "oauth", deps);
  // A failed or cancelled sign-in must not discard a working token connection.
  removeCredential(provider);
  return ok({ ...status, connection: { provider, connected: true, deviceLogin: true, source: "oauth", ...identity } });
}

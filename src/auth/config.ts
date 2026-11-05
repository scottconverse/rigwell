// Per-provider OAuth configuration (settings key `oauthProviders`). Rigwell ships no provider entries and no client ids:
// the user registers their own client with a provider and describes it here (docs/auth.md).
import { KEYCHAIN_PREFIX, lookupCredential } from "../storage/credentials.ts";

export interface OAuthProviderConfig {
  /** The key in `oauthProviders`; a custom model refers to it as `credentialSource`. */
  name: string;
  /** The user's own registered client. */
  clientId: string;
  /** Only for confidential clients. May be `keychain:<name>` or contain ${ENV_VAR}. */
  clientSecret?: string;
  /** How the client authenticates at the token endpoint (default: "none" without a secret, else "client_secret_post"). */
  tokenAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  /** Present: the device authorization grant (RFC 8628) is available. */
  deviceAuthorizationEndpoint?: string;
  scopes: string[];
  /** Fixed loopback port for the redirect (some providers need an exact registered URI). 0 or absent: a free port. */
  redirectPort?: number;
  /** Path of the loopback redirect (default "/callback"). */
  redirectPath: string;
  /** Extra query parameters on the authorization request (e.g. audience). */
  authParams: Record<string, string>;
  /** Extra form fields on every token request (MCP sign-in sends the RFC 8707 `resource` here). */
  tokenParams?: Record<string, string>;
  /** Where the model API lives; used when the custom model has no baseUrl. */
  apiBaseUrl?: string;
  /** How the access token is sent. Defaults: header "authorization", scheme "Bearer" (scheme "" sends the bare token). */
  tokenHeader: string;
  tokenScheme: string;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** https, or http on a loopback host (local test servers and identity providers on the same machine). */
export function secureUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (x.hostname === "127.0.0.1" || x.hostname === "localhost" || x.hostname === "[::1]");
  } catch { return false; }
}

/** Validates the `oauthProviders` settings object. Bad entries are skipped and reported; never throws. */
export function parseOAuthProviders(raw: unknown, env: Record<string, string | undefined> = process.env): { providers: Map<string, OAuthProviderConfig>; problems: string[] } {
  const providers = new Map<string, OAuthProviderConfig>();
  const problems: string[] = [];
  if (raw === undefined) return { providers, problems };
  if (!isObj(raw)) return { providers, problems: ["oauthProviders must be an object"] };
  for (const [name, e] of Object.entries(raw)) {
    const bad = (m: string) => problems.push(`oauthProviders.${name}: ${m}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) { bad("name must be 1-64 letters, digits, '.', '_' or '-'"); continue; }
    if (!isObj(e)) { bad("must be an object"); continue; }
    if (typeof e.clientId !== "string" || !e.clientId.trim()) { bad("clientId is required (register your own client with the provider)"); continue; }
    if (!secureUrl(e.tokenEndpoint)) { bad("tokenEndpoint must be an https URL"); continue; }
    if (e.authorizationEndpoint !== undefined && !secureUrl(e.authorizationEndpoint)) { bad("authorizationEndpoint must be an https URL"); continue; }
    if (e.deviceAuthorizationEndpoint !== undefined && !secureUrl(e.deviceAuthorizationEndpoint)) { bad("deviceAuthorizationEndpoint must be an https URL"); continue; }
    if (e.authorizationEndpoint === undefined && e.deviceAuthorizationEndpoint === undefined) { bad("needs authorizationEndpoint or deviceAuthorizationEndpoint"); continue; }
    if (e.apiBaseUrl !== undefined && !secureUrl(e.apiBaseUrl)) { bad("apiBaseUrl must be an https URL"); continue; }
    if (e.scopes !== undefined && (!Array.isArray(e.scopes) || e.scopes.some((s) => typeof s !== "string" || /\s/.test(s) || !s))) { bad("scopes must be an array of strings without spaces"); continue; }
    if (e.redirectPort !== undefined && (!Number.isInteger(e.redirectPort) || (e.redirectPort as number) < 0 || (e.redirectPort as number) > 65535)) { bad("redirectPort must be 0-65535"); continue; }
    if (e.redirectPath !== undefined && (typeof e.redirectPath !== "string" || !e.redirectPath.startsWith("/"))) { bad("redirectPath must start with '/'"); continue; }
    if (e.authParams !== undefined && (!isObj(e.authParams) || Object.values(e.authParams).some((v) => typeof v !== "string"))) { bad("authParams must be an object of strings"); continue; }
    const methods = ["none", "client_secret_post", "client_secret_basic"];
    if (e.tokenAuthMethod !== undefined && !methods.includes(e.tokenAuthMethod as string)) { bad(`tokenAuthMethod must be one of ${methods.join(", ")}`); continue; }
    if (e.tokenHeader !== undefined && (typeof e.tokenHeader !== "string" || !/^[A-Za-z0-9-]+$/.test(e.tokenHeader))) { bad("tokenHeader must be a header name"); continue; }
    if (e.tokenScheme !== undefined && typeof e.tokenScheme !== "string") { bad("tokenScheme must be a string"); continue; }
    let clientSecret: string | undefined;
    if (e.clientSecret !== undefined) {
      if (typeof e.clientSecret !== "string") { bad("clientSecret must be a string"); continue; }
      if (e.clientSecret.startsWith(KEYCHAIN_PREFIX)) {
        const key = e.clientSecret.slice(KEYCHAIN_PREFIX.length).trim();
        clientSecret = key ? lookupCredential(key) : undefined;
        if (!clientSecret) { bad(`no stored credential named ${JSON.stringify(key)}`); continue; }
      } else {
        const missing: string[] = [];
        clientSecret = e.clientSecret.replace(ENV_REF, (_m, n: string) => { const v = env[n]; if (v === undefined || v === "") missing.push(n); return v ?? ""; });
        if (missing.length) { bad(`unset environment variable(s): ${missing.join(", ")}`); continue; }
      }
    }
    providers.set(name, {
      name, clientId: e.clientId.trim(),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      tokenAuthMethod: (e.tokenAuthMethod as OAuthProviderConfig["tokenAuthMethod"]) ?? (clientSecret ? "client_secret_post" : "none"),
      ...(e.authorizationEndpoint ? { authorizationEndpoint: e.authorizationEndpoint as string } : {}),
      tokenEndpoint: e.tokenEndpoint as string,
      ...(e.deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint: e.deviceAuthorizationEndpoint as string } : {}),
      scopes: (e.scopes as string[] | undefined) ?? [],
      ...(e.redirectPort !== undefined ? { redirectPort: e.redirectPort as number } : {}),
      redirectPath: (e.redirectPath as string | undefined) ?? "/callback",
      authParams: (e.authParams as Record<string, string> | undefined) ?? {},
      ...(e.apiBaseUrl ? { apiBaseUrl: e.apiBaseUrl as string } : {}),
      tokenHeader: ((e.tokenHeader as string | undefined) ?? "authorization").toLowerCase(),
      tokenScheme: (e.tokenScheme as string | undefined) ?? "Bearer",
    });
  }
  return { providers, problems };
}

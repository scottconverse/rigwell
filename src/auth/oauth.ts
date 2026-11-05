// Generic OAuth 2.0 client: authorization code with PKCE (RFC 7636) over a 127.0.0.1 loopback redirect (RFC 8252), the device
// authorization grant (RFC 8628), refresh (RFC 6749 section 6) and token storage in the credential store (spec 12.2).
// Nothing here knows any particular provider: endpoints, client id and scopes come from `oauthProviders` settings.
import { createHash, randomBytes } from "node:crypto";
import type { OAuthProviderConfig } from "./config.ts";
import { lookupCredential, removeCredential, storeCredential } from "../storage/credentials.ts";

export class AuthError extends Error {
  constructor(readonly code: "not_logged_in" | "expired" | "denied" | "failed" | "timeout" | "unsupported", message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the provider gave no lifetime (the token is then used until the API rejects it). */
  expiresAt?: number;
  tokenType: string;
  scope?: string;
  obtainedAt: number;
}

export type LoginState = "pending" | "complete" | "failed" | "cancelled";

/** What a client shows the user and polls. Never holds a token. */
export interface LoginStatus {
  loginId: string;
  name: string;
  kind: "browser" | "device";
  state: LoginState;
  /** browser: open this URL. */
  url?: string;
  /** device: show these. */
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt: number;
  error?: string;
}

export interface AuthManagerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before the stated expiry (ms, default 60 s). */
  skewMs?: number;
  /** How long a browser or device login may take (ms, default 5 minutes). */
  loginTimeoutMs?: number;
  /** Unit of the device `interval` (default 1000 ms per second; tests shrink it). */
  intervalUnitMs?: number;
}

export const tokenKey = (name: string) => `oauth:${name}`;
const b64url = (b: Buffer) => b.toString("base64url");

export function newPkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function loadToken(name: string): StoredToken | undefined {
  const raw = lookupCredential(tokenKey(name));
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    return j && typeof j.accessToken === "string" ? (j as StoredToken) : undefined;
  } catch { return undefined; }
}

function saveToken(name: string, t: StoredToken) { storeCredential(tokenKey(name), JSON.stringify(t)); }

interface Login {
  id: string;
  cfg: OAuthProviderConfig;
  status: LoginStatus;
  stop: () => void;
  done: Promise<void>;
}

export class AuthManager {
  private logins = new Map<string, Login>();
  private refreshing = new Map<string, Promise<StoredToken>>();
  private f: typeof fetch;
  private now: () => number;

  constructor(private o: AuthManagerOptions = {}) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  // ---------- tokens ----------

  /** A bearer token that is valid now: refreshed first when it expired. */
  async accessToken(cfg: OAuthProviderConfig): Promise<string> {
    let t = loadToken(cfg.name);
    if (!t) throw new AuthError("not_logged_in", `Not signed in to "${cfg.name}": run \`rigwell auth login ${cfg.name}\``);
    if (this.expired(t)) t = await this.refresh(cfg, t);
    return t.accessToken;
  }

  /** The request header that carries the token for this provider. */
  async headers(cfg: OAuthProviderConfig): Promise<Record<string, string>> {
    const tok = await this.accessToken(cfg);
    return { [cfg.tokenHeader]: cfg.tokenScheme ? `${cfg.tokenScheme} ${tok}` : tok };
  }

  private expired(t: StoredToken): boolean {
    return t.expiresAt !== undefined && this.now() >= t.expiresAt - (this.o.skewMs ?? 60_000);
  }

  private refresh(cfg: OAuthProviderConfig, old: StoredToken): Promise<StoredToken> {
    let p = this.refreshing.get(cfg.name);
    if (!p) {
      p = (async () => {
        if (!old.refreshToken) throw new AuthError("expired", `The "${cfg.name}" sign-in expired and has no refresh token: run \`rigwell auth login ${cfg.name}\``);
        try {
          const json = await this.tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: old.refreshToken });
          const fresh = this.toStored(json, old);
          saveToken(cfg.name, fresh);
          return fresh;
        } catch (e) {
          if (e instanceof AuthError && e.code === "denied") throw new AuthError("expired", `The "${cfg.name}" sign-in was revoked or expired: run \`rigwell auth login ${cfg.name}\``);
          throw e;
        }
      })().finally(() => this.refreshing.delete(cfg.name));
      this.refreshing.set(cfg.name, p);
    }
    return p;
  }

  private toStored(j: Record<string, unknown>, prev?: StoredToken): StoredToken {
    if (typeof j.access_token !== "string" || !j.access_token) throw new AuthError("failed", "The token endpoint answered without an access_token");
    const life = typeof j.expires_in === "number" ? j.expires_in : typeof j.expires_in === "string" && j.expires_in.trim() !== "" ? Number(j.expires_in) : NaN;
    const now = this.now();
    return {
      accessToken: j.access_token,
      // A refresh response may omit a new refresh token: the old one stays valid (RFC 6749 6).
      ...(typeof j.refresh_token === "string" && j.refresh_token ? { refreshToken: j.refresh_token } : prev?.refreshToken ? { refreshToken: prev.refreshToken } : {}),
      ...(Number.isFinite(life) ? { expiresAt: now + life * 1000 } : {}),
      tokenType: typeof j.token_type === "string" ? j.token_type : "Bearer",
      ...(typeof j.scope === "string" ? { scope: j.scope } : prev?.scope ? { scope: prev.scope } : {}),
      obtainedAt: now,
    };
  }

  /** POST to the token endpoint. Errors carry the OAuth error code and description only, never the request. */
  private async tokenRequest(cfg: OAuthProviderConfig, params: Record<string, string>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({ ...(cfg.tokenParams ?? {}), ...params });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (cfg.tokenAuthMethod === "client_secret_basic" && cfg.clientSecret !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`;
    } else {
      body.set("client_id", cfg.clientId);
      if (cfg.tokenAuthMethod === "client_secret_post" && cfg.clientSecret !== undefined) body.set("client_secret", cfg.clientSecret);
    }
    let res: Response;
    try {
      res = await this.f(cfg.tokenEndpoint, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new AuthError("failed", `Could not reach the token endpoint of "${cfg.name}": ${(e as Error)?.message ?? e}`);
    }
    let j: Record<string, unknown> = {};
    try { j = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    if (!res.ok || typeof j.error === "string") {
      const code = typeof j.error === "string" ? j.error : `http_${res.status}`;
      const desc = typeof j.error_description === "string" ? `: ${j.error_description}` : "";
      const kind = code === "invalid_grant" || code === "access_denied" || code === "expired_token" || code === "invalid_client" || code === "unauthorized_client" ? "denied" : "failed";
      const err = new AuthError(kind, `Token endpoint error ${code}${desc}`);
      (err as AuthError & { oauthError?: string }).oauthError = code;
      throw err;
    }
    return j;
  }

  // ---------- login ----------

  list(providers: Iterable<OAuthProviderConfig>) {
    return [...providers].map((cfg) => {
      const t = loadToken(cfg.name);
      return {
        name: cfg.name, loggedIn: !!t,
        ...(t ? { expiresAt: t.expiresAt, expired: this.expired(t), hasRefreshToken: !!t.refreshToken, scope: t.scope } : {}),
        scopes: cfg.scopes, apiBaseUrl: cfg.apiBaseUrl, browserLogin: !!cfg.authorizationEndpoint, deviceLogin: !!cfg.deviceAuthorizationEndpoint,
      };
    });
  }

  logout(name: string): boolean {
    for (const l of this.logins.values()) if (l.cfg.name === name && l.status.state === "pending") l.stop();
    return removeCredential(tokenKey(name));
  }

  /** Starts a login and returns what the user must do. `mode` defaults to the browser flow, else the device flow. */
  async loginStart(cfg: OAuthProviderConfig, mode?: "browser" | "device"): Promise<LoginStatus> {
    const m = mode ?? (cfg.authorizationEndpoint ? "browser" : "device");
    if (m === "browser" && !cfg.authorizationEndpoint) throw new AuthError("unsupported", `"${cfg.name}" has no authorizationEndpoint: use the device flow`);
    if (m === "device" && !cfg.deviceAuthorizationEndpoint) throw new AuthError("unsupported", `"${cfg.name}" has no deviceAuthorizationEndpoint`);
    for (const l of this.logins.values()) if (l.cfg.name === cfg.name && l.status.state === "pending") l.stop(); // a new attempt replaces the old one
    return m === "browser" ? this.startBrowser(cfg) : this.startDevice(cfg);
  }

  loginStatus(loginId: string): LoginStatus | undefined { return this.logins.get(loginId)?.status; }

  /** Resolves when the login ended (CLI). */
  async waitLogin(loginId: string): Promise<LoginStatus> {
    const l = this.logins.get(loginId);
    if (!l) throw new AuthError("failed", "unknown login");
    await l.done;
    return l.status;
  }

  private register(cfg: OAuthProviderConfig, kind: "browser" | "device", extra: Partial<LoginStatus>, run: (finish: (error?: string, cancelled?: boolean) => void, signal: AbortSignal) => void): LoginStatus {
    const id = crypto.randomUUID();
    const timeout = this.o.loginTimeoutMs ?? 5 * 60_000;
    const status: LoginStatus = { loginId: id, name: cfg.name, kind, state: "pending", expiresAt: this.now() + timeout, ...extra };
    const ac = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: string, cancelled?: boolean) => {
      if (status.state !== "pending") return;
      status.state = cancelled ? "cancelled" : error ? "failed" : "complete";
      if (error) status.error = error;
      if (timer) clearTimeout(timer);
      ac.abort();
      cleanups.forEach((c) => c());
      resolveDone();
      // Finished logins stay readable for a while so a client can poll the final state.
      const gc = setTimeout(() => this.logins.delete(id), 10 * 60_000);
      gc.unref?.();
    };
    const cleanups: (() => void)[] = [];
    (finish as any).onCleanup = (fn: () => void) => cleanups.push(fn);
    timer = setTimeout(() => finish("Timed out waiting for the sign-in to finish"), timeout);
    timer.unref?.();
    this.logins.set(id, { id, cfg, status, stop: () => finish(undefined, true), done });
    run(finish, ac.signal);
    return status;
  }

  private async startBrowser(cfg: OAuthProviderConfig): Promise<LoginStatus> {
    const { verifier, challenge } = newPkce();
    const state = b64url(randomBytes(24));
    let finishRef!: (error?: string, cancelled?: boolean) => void;
    let redirectUri = "";
    const server = Bun.serve({
      hostname: "127.0.0.1", port: cfg.redirectPort ?? 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        if (req.method !== "GET" || u.pathname !== cfg.redirectPath) return new Response("Not found", { status: 404 });
        const page = (msg: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>Rigwell</title><p>${msg}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
        // The state ties this redirect to our request: anything else (another local program, a stray tab) is refused.
        if (u.searchParams.get("state") !== state) return page("Unexpected sign-in response ignored.", 400);
        const err = u.searchParams.get("error");
        if (err) { finishRef(`The provider refused the sign-in: ${err}`); return page("Sign-in was refused. You can close this tab."); }
        const code = u.searchParams.get("code");
        if (!code) return page("Missing code.", 400);
        try {
          const json = await this.tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
          saveToken(cfg.name, this.toStored(json));
          finishRef();
          return page("Signed in to Rigwell. You can close this tab.");
        } catch (e) {
          finishRef((e as Error).message);
          return page("Sign-in failed. See the Rigwell window for details.", 502);
        }
      },
    });
    redirectUri = `http://127.0.0.1:${server.port}${cfg.redirectPath}`;
    const url = new URL(cfg.authorizationEndpoint!);
    for (const [k, v] of Object.entries(cfg.authParams)) url.searchParams.set(k, v);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (cfg.scopes.length) url.searchParams.set("scope", cfg.scopes.join(" "));
    return this.register(cfg, "browser", { url: url.toString() }, (finish) => {
      finishRef = finish;
      (finish as any).onCleanup(() => setTimeout(() => void server.stop(true), 200)); // let the last response go out
    });
  }

  private async startDevice(cfg: OAuthProviderConfig): Promise<LoginStatus> {
    const body = new URLSearchParams({ client_id: cfg.clientId });
    if (cfg.scopes.length) body.set("scope", cfg.scopes.join(" "));
    let j: Record<string, any> = {};
    try {
      const res = await this.f(cfg.deviceAuthorizationEndpoint!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(), signal: AbortSignal.timeout(30_000) });
      j = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) throw new AuthError("failed", `Device authorization failed: ${typeof j.error === "string" ? j.error : `http_${res.status}`}`);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("failed", `Could not reach the device authorization endpoint of "${cfg.name}": ${(e as Error)?.message ?? e}`);
    }
    const deviceCode = j.device_code, userCode = j.user_code, uri = j.verification_uri ?? j.verification_url;
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof uri !== "string") throw new AuthError("failed", "The device authorization response is missing device_code, user_code or verification_uri");
    const unit = this.o.intervalUnitMs ?? 1000;
    let interval = (typeof j.interval === "number" && j.interval >= 0 ? j.interval : 5) * unit;
    const lifetime = typeof j.expires_in === "number" ? j.expires_in * unit : undefined;
    const status = this.register(cfg, "device", {
      userCode, verificationUri: uri, ...(typeof j.verification_uri_complete === "string" ? { verificationUriComplete: j.verification_uri_complete } : {}),
    }, (finish, signal) => {
      void (async () => {
        const deadline = lifetime !== undefined ? this.now() + lifetime : Infinity;
        try {
          for (;;) {
            await new Promise((r) => { const t = setTimeout(r, interval); signal.addEventListener("abort", () => { clearTimeout(t); r(undefined); }, { once: true }); });
            if (signal.aborted) return;
            if (this.now() > deadline) return finish("The device code expired");
            try {
              const json = await this.tokenRequest(cfg, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode });
              if (signal.aborted) return;
              saveToken(cfg.name, this.toStored(json));
              return finish();
            } catch (e) {
              const code = (e as { oauthError?: string }).oauthError;
              if (code === "authorization_pending") continue;
              if (code === "slow_down") { interval += 5 * unit; continue; }
              return finish(e instanceof AuthError && code === "access_denied" ? "The sign-in was denied" : (e as Error).message);
            }
          }
        } catch (e) { finish((e as Error).message); }
      })();
    });
    if (lifetime !== undefined) status.expiresAt = Math.min(status.expiresAt, this.now() + lifetime);
    return status;
  }
}

let shared: AuthManager | undefined;
/** The process-wide manager (token refresh is single-flight per provider through it). */
export function authManager(): AuthManager { return (shared ??= new AuthManager()); }
export function setAuthManager(m: AuthManager | undefined) { shared = m; }

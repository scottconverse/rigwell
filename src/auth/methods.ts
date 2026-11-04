// Protocol methods for OAuth sign-in (names without the "rigwell." prefix): auth_list, auth_login_start, auth_login_status, auth_logout.
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { parseOAuthProviders, type OAuthProviderConfig } from "./config.ts";
import { AuthError, authManager } from "./oauth.ts";

export async function handleAuthMethod(
  method: string, p: Record<string, unknown>, settings: () => { oauthProviders?: unknown },
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!["auth_list", "auth_login_start", "auth_login_status", "auth_logout"].includes(method)) return { handled: false };
  const mgr = authManager();
  const { providers, problems } = parseOAuthProviders(settings().oauthProviders);
  const provider = (): OAuthProviderConfig => {
    if (typeof p.name !== "string" || !p.name) throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
    const cfg = providers.get(p.name);
    if (!cfg) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `No OAuth provider named ${JSON.stringify(p.name)} in oauthProviders${problems.length ? ` (${problems.join("; ")})` : ""}`);
    return cfg;
  };
  switch (method) {
    case "auth_list": return { handled: true, result: { providers: mgr.list(providers.values()), problems } };
    case "auth_login_start": {
      const cfg = provider();
      if (p.mode !== undefined && p.mode !== "browser" && p.mode !== "device") throw new RpcError(ErrorCodes.INVALID_PARAMS, "mode must be \"browser\" or \"device\"");
      try { return { handled: true, result: await mgr.loginStart(cfg, p.mode as "browser" | "device" | undefined) }; } catch (e) {
        if (e instanceof AuthError) throw new RpcError(ErrorCodes.INVALID_PARAMS, e.message);
        throw e;
      }
    }
    case "auth_login_status": {
      const s = typeof p.loginId === "string" ? mgr.loginStatus(p.loginId) : undefined;
      if (!s) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, "Unknown loginId");
      return { handled: true, result: s };
    }
    default: { // auth_logout
      if (typeof p.name !== "string" || !p.name) throw new RpcError(ErrorCodes.INVALID_PARAMS, "name is required");
      return { handled: true, result: { loggedOut: mgr.logout(p.name) } }; // works even after the provider entry was removed
    }
  }
}

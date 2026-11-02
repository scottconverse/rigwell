// The one call the model adapters make to attach an OAuth token (spec 12.2 `credentialSource`).
import { ModelError, type ModelConfig } from "../core/types.ts";
import { authManager } from "./oauth.ts";

/** {} for a model without `credentialSource`; else the provider's token header, refreshed first when the token expired. */
export async function oauthHeaders(m: ModelConfig): Promise<Record<string, string>> {
  if (!m.oauth) return {};
  try {
    return await authManager().headers(m.oauth);
  } catch (e) {
    // Not retryable: the user has to sign in again.
    throw new ModelError("auth", (e as Error)?.message ?? String(e), { retryable: false });
  }
}

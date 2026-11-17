import { createPublicKey, verify } from "node:crypto";
import { apiJson } from "../automations/triggers/http.ts";
import { secretValue } from "../secrets/store.ts";
import type { DelegationConfig, Source } from "./store.ts";

type Config = NonNullable<DelegationConfig["teams"]>;
export interface TeamsDeps { fetch?: typeof fetch; metadataUrl?: string; tokenUrl?: string; credential?: (name: string) => string | undefined; now?: () => number }
export class TeamsConnector {
  private keys: any[] = []; private refreshed = 0; private fetching?: Promise<void>;
  private token?: { value: string; until: number }; private obtaining?: Promise<string>;
  private abort = new AbortController();
  constructor(private config: Config, private deps: TeamsDeps = {}) {}
  private now() { return (this.deps.now ?? Date.now)(); }
  private async refresh() {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const metadataUrl = this.deps.metadataUrl ?? "https://login.botframework.com/v1/.well-known/openidconfiguration";
      const { body: meta } = await apiJson(metadataUrl, undefined, {}, this.deps.fetch, this.abort.signal);
      const keysUrl = new URL(meta.jwks_uri), metadata = new URL(metadataUrl);
      if (meta.issuer !== "https://api.botframework.com" || !Array.isArray(meta.id_token_signing_alg_values_supported) || !meta.id_token_signing_alg_values_supported.includes("RS256") || keysUrl.origin !== metadata.origin || keysUrl.username || keysUrl.password || keysUrl.hash) throw new Error("Invalid Bot Framework signing metadata");
      const { body } = await apiJson(keysUrl.href, undefined, {}, this.deps.fetch, this.abort.signal);
      if (!Array.isArray(body.keys) || body.keys.length > 100) throw new Error("Invalid Bot Framework signing keys");
      this.keys = body.keys; this.refreshed = this.now();
    })().finally(() => { this.fetching = undefined; });
    return this.fetching;
  }
  async authenticate(authorization: string | null, activity: any): Promise<Source> {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization ?? "")?.[1];
    if (!token || token.length > 32_768) throw new Error("Bot Framework authentication required");
    const [head, payload, signature] = token.split("."), header = JSON.parse(Buffer.from(head!, "base64url").toString()), claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) throw new Error("Unsupported Bot Framework signature");
    if (!this.refreshed || this.now() - this.refreshed >= 24 * 60 * 60_000) await this.refresh();
    let key = this.keys.find((k) => k.kid === header.kid);
    if (!key && this.now() - this.refreshed >= 60_000) { await this.refresh(); key = this.keys.find((k) => k.kid === header.kid); }
    if (!key || key.kty !== "RSA" || (key.use && key.use !== "sig") || (key.alg && key.alg !== "RS256") || !Array.isArray(key.endorsements) || !key.endorsements.includes("msteams") || !verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), createPublicKey({ key, format: "jwk" }), Buffer.from(signature!, "base64url"))) throw new Error("Invalid Bot Framework signature or channel endorsement");
    const now = this.now() / 1000;
    if (claims.iss !== "https://api.botframework.com" || claims.aud !== this.config.appId || !Number.isFinite(claims.exp) || !Number.isFinite(claims.nbf) || claims.exp < now - 300 || claims.nbf > now + 300 || typeof claims.serviceurl !== "string" || claims.serviceurl !== activity.serviceUrl) throw new Error("Invalid Bot Framework token claims");
    const url = new URL(activity.serviceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(url.hostname)) throw new Error("Invalid Bot Framework service URL");
    const tenant = String(activity.channelData?.tenant?.id ?? "").toLowerCase(), user = String(activity.from?.aadObjectId ?? "").toLowerCase();
    if (activity.channelId !== "msteams" || tenant !== this.config.tenantId || !this.config.users.includes(user) || typeof activity.conversation?.id !== "string" || !activity.conversation.id || activity.conversation.id.length > 1024 || typeof activity.id !== "string" || !activity.id || activity.id.length > 1024 || typeof activity.recipient?.id !== "string") throw new Error("Teams user or conversation is not allowed");
    return { service: "teams", workspace: tenant, user, conversation: activity.conversation.id, thread: activity.conversation.conversationType === "channel" ? String(activity.replyToId ?? activity.id) : "", serviceUrl: url.href, botId: activity.recipient.id };
  }
  private async accessToken() {
    if (this.token && this.token.until > this.now() + 60_000) return this.token.value;
    if (this.obtaining) return this.obtaining;
    this.obtaining = (async () => {
      const secret = (this.deps.credential ?? secretValue)(this.config.secretCredential); if (!secret) throw new Error(`Missing stored Teams credential: ${this.config.secretCredential}`);
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.appId, client_secret: secret, scope: "https://api.botframework.com/.default" });
      const { body: result } = await apiJson(this.deps.tokenUrl ?? `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, undefined, { method: "POST", body: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }, this.deps.fetch, this.abort.signal);
      if (result.token_type?.toLowerCase() !== "bearer" || typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in < 120) throw new Error("Invalid Teams access token response");
      this.token = { value: result.access_token, until: this.now() + Math.min(result.expires_in, 3600) * 1000 }; return this.token.value;
    })().finally(() => { this.obtaining = undefined; });
    return this.obtaining;
  }
  async send(source: Source, text: string, choices?: { label: string; value: string }[]) {
    const token = await this.accessToken();
    const activity: any = { type: "message", text, textFormat: "plain", from: { id: source.botId }, recipient: { aadObjectId: source.user }, conversation: { id: source.conversation }, ...(source.thread ? { replyToId: source.thread } : {}) };
    if (choices?.length) activity.attachments = [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }], actions: choices.map((c) => ({ type: "Action.Execute", title: c.label.slice(0, 80), verb: "rigwell.answer", data: { token: c.value } })) } }];
    return apiJson(`${source.serviceUrl!.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(source.conversation)}/activities`, token, { method: "POST", body: JSON.stringify(activity) }, this.deps.fetch, this.abort.signal);
  }
  stop() { this.abort.abort(); this.token = undefined; }
}

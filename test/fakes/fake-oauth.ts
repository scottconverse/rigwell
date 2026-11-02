// A local fake OAuth 2.0 authorization server: authorize (PKCE), token (code, refresh, device), device authorization.
import { createHash } from "node:crypto";

export interface FakeOAuth {
  url: string;
  /** Every request to /token: the parsed form and the Authorization header. */
  tokenRequests: { form: Record<string, string>; authorization?: string }[];
  /** Lifetime in seconds for the next tokens (default 3600). */
  expiresIn: number;
  /** Device grant: answer authorization_pending this many times first. */
  pendingPolls: number;
  /** Refresh answers invalid_grant. */
  revoked: boolean;
  issued: number;
  stop(): void;
}

export function startFakeOAuth(): FakeOAuth {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let polls = 0;
  const self: FakeOAuth = { url: "", tokenRequests: [], expiresIn: 3600, pendingPolls: 0, revoked: false, issued: 0, stop: () => server.stop(true) };
  const issue = (refresh = true) => {
    self.issued++;
    return Response.json({ access_token: `access-${self.issued}`, ...(refresh ? { refresh_token: `refresh-${self.issued}` } : {}), token_type: "Bearer", expires_in: self.expiresIn, scope: "models.read" });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/authorize") {
        const q = u.searchParams;
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || q.get("response_type") !== "code") return new Response("bad request", { status: 400 });
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")! });
        return new Response(null, { status: 302, headers: { location: `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state")!)}` } });
      }
      if (u.pathname === "/device") return Response.json({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: `${self.url}/activate`, expires_in: 600, interval: 1 });
      if (u.pathname === "/token") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        self.tokenRequests.push({ form, authorization: req.headers.get("authorization") ?? undefined });
        const err = (error: string) => Response.json({ error, error_description: `fake ${error}` }, { status: 400 });
        if (form.grant_type === "authorization_code") {
          const c = codes.get(form.code ?? "");
          if (!c || c.redirect !== form.redirect_uri) return err("invalid_grant");
          if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== c.challenge) return err("invalid_grant");
          codes.delete(form.code!);
          return issue();
        }
        if (form.grant_type === "refresh_token") {
          if (self.revoked || !form.refresh_token?.startsWith("refresh-")) return err("invalid_grant");
          return issue(false); // no rotation: the old refresh token stays
        }
        if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          if (form.device_code !== "dev-1") return err("invalid_grant");
          if (polls++ < self.pendingPolls) return err("authorization_pending");
          return issue();
        }
        return err("unsupported_grant_type");
      }
      return new Response("not found", { status: 404 });
    },
  });
  self.url = `http://127.0.0.1:${server.port}`;
  return self;
}

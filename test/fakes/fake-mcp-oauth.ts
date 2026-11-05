// A fake MCP server that needs OAuth, plus its authorization server on the same origin: protected resource metadata
// (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE, resource
// indicators (RFC 8707) and refresh. /mcp answers 401 with WWW-Authenticate until a valid bearer token comes.
import { createHash } from "node:crypto";
import { handleMcpRequest } from "./fake-mcp-core.ts";

export interface FakeMcpOAuthOptions {
  /** Offer dynamic client registration (default true). */
  registration?: boolean;
  /** Put resource_metadata in the 401 header (default true); false: the client must try the well-known path. */
  headerHint?: boolean;
  /** A pre-registered client id (for oauth.clientId). */
  staticClient?: string;
  /** "legacy": the old SSE transport on /sse. */
  mode?: "json" | "legacy";
}

export function startFakeMcpOAuth(o: FakeMcpOAuthOptions = {}) {
  const clients = new Map<string, { redirects: string[] }>();
  if (o.staticClient) clients.set(o.staticClient, { redirects: [] });
  const codes = new Map<string, { challenge: string; redirect: string; client: string; resource: string }>();
  const access = new Map<string, number>(); // token -> expiry (epoch ms)
  const refresh = new Set<string>();
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const self = {
    url: "", origin: "", resource: "",
    registrations: 0, tokenRequests: [] as Record<string, string>[], authorizeRequests: [] as Record<string, string>[],
    mcpAuth: [] as (string | null)[],
    /** Lifetime of new access tokens in seconds. */
    expiresIn: 3600,
    /** Reject every token from now on (forces a new sign-in). */
    revokeAll() { access.clear(); refresh.clear(); },
    stop: () => server.stop(true),
  };
  let n = 0;
  const issue = () => {
    n++;
    const at = `mcp-access-${n}`, rt = `mcp-refresh-${n}`;
    access.set(at, Date.now() + self.expiresIn * 1000);
    refresh.add(rt);
    return Response.json({ access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: self.expiresIn, scope: "tools.read" });
  };
  const unauthorized = () => new Response("unauthorized", {
    status: 401,
    headers: { "www-authenticate": o.headerHint === false ? `Bearer realm="fake"` : `Bearer realm="fake", resource_metadata="${self.origin}/.well-known/oauth-protected-resource/mcp", scope="tools.read"` },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === "/.well-known/oauth-protected-resource/mcp" || p === "/.well-known/oauth-protected-resource/sse") {
        return Response.json({ resource: self.resource, authorization_servers: [self.origin], scopes_supported: ["tools.read"] });
      }
      if (p === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: self.origin, authorization_endpoint: `${self.origin}/authorize`, token_endpoint: `${self.origin}/token`,
          ...(o.registration === false ? {} : { registration_endpoint: `${self.origin}/register` }),
          code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
        });
      }
      if (p === "/register" && req.method === "POST" && o.registration !== false) {
        const j = await req.json() as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
        self.registrations++;
        const id = `client-${self.registrations}`;
        clients.set(id, { redirects: j.redirect_uris ?? [] });
        return Response.json({ client_id: id, redirect_uris: j.redirect_uris, token_endpoint_auth_method: "none" }, { status: 201 });
      }
      if (p === "/authorize") {
        const q = Object.fromEntries(u.searchParams);
        self.authorizeRequests.push(q);
        const c = clients.get(q.client_id ?? "");
        if (!c) return new Response("unknown client", { status: 400 });
        if (c.redirects.length && !c.redirects.includes(q.redirect_uri!)) return new Response("redirect_uri not registered", { status: 400 });
        if (q.code_challenge_method !== "S256" || !q.code_challenge || q.response_type !== "code" || q.resource !== self.resource) return new Response("bad request", { status: 400 });
        const code = `code-${codes.size + 1}-${n}`;
        codes.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri!, client: q.client_id!, resource: q.resource });
        return new Response(null, { status: 302, headers: { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state!)}` } });
      }
      if (p === "/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        self.tokenRequests.push(form);
        const err = (error: string) => Response.json({ error }, { status: 400 });
        if (form.resource !== self.resource) return err("invalid_target");
        if (form.grant_type === "authorization_code") {
          const c = codes.get(form.code ?? "");
          if (!c || c.redirect !== form.redirect_uri || c.client !== form.client_id) return err("invalid_grant");
          if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== c.challenge) return err("invalid_grant");
          codes.delete(form.code!);
          return issue();
        }
        if (form.grant_type === "refresh_token") {
          if (!refresh.has(form.refresh_token ?? "")) return err("invalid_grant");
          refresh.delete(form.refresh_token!);
          return issue();
        }
        return err("unsupported_grant_type");
      }
      if (p === "/mcp" || p === "/sse" || p === "/messages") {
        const h = req.headers.get("authorization");
        self.mcpAuth.push(h);
        const tok = h?.startsWith("Bearer ") ? h.slice(7) : "";
        const exp = access.get(tok);
        if (exp === undefined || exp < Date.now()) return unauthorized();
        if (o.mode === "legacy") {
          if (req.method === "GET") {
            return new Response(new ReadableStream({ start(c) { streams.push(c); c.enqueue(enc.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
          }
          const res = handleMcpRequest(await req.json());
          if (res) streams.at(-1)?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(res)}\n\n`));
          return new Response("Accepted", { status: 202 });
        }
        if (req.method === "DELETE") return new Response(null, { status: 200 });
        const res = handleMcpRequest(await req.json());
        if (!res) return new Response(null, { status: 202 });
        return Response.json(res);
      }
      return new Response("not found", { status: 404 });
    },
  });
  self.origin = `http://127.0.0.1:${server.port}`;
  self.url = o.mode === "legacy" ? `${self.origin}/sse` : `${self.origin}/mcp`;
  self.resource = self.url;
  return self;
}

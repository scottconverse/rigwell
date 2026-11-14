import { startFakeOAuth } from "./fake-oauth.ts";
import { handleMcpRequest } from "./fake-mcp-core.ts";

/** Strict local resource and authorization server, including exact registered redirect validation. */
export function startFakeMcpOAuth() {
  const oauth = startFakeOAuth();
  const registrations: any[] = [], seen: { method: string; token: string | null; path: string }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const state = { dcr: true, pkce: true, issuerMatches: true, resourceMatches: true, oidcOnly: false, rejectTokens: false, redirect: "", expiresIn: 3600, legacy: false, endpoint: "/messages" };
  let base = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url);
    const resource = `${base}/mcp`;
    if (u.pathname === "/metadata") return Response.json({ resource: state.resourceMatches ? resource : `${base}/other`, authorization_servers: [`${base}/issuer`], scopes_supported: ["tools.read"] });
    if (u.pathname.includes(".well-known")) {
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource, authorization_servers: [`${base}/issuer`] });
      if (state.oidcOnly && !u.pathname.includes("openid-configuration")) return new Response(null, { status: 404 });
      return Response.json({ issuer: `${base}/${state.issuerMatches ? "issuer" : "wrong"}`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, ...(state.dcr ? { registration_endpoint: `${base}/register` } : {}), code_challenge_methods_supported: state.pkce ? ["S256"] : [] });
    }
    if (u.pathname === "/register") {
      const body = await req.json() as any; registrations.push(body);
      if (body.redirect_uris?.length !== 1 || !/^http:\/\/127\.0\.0\.1:\d+\/mcp-callback$/.test(body.redirect_uris[0])) return new Response(null, { status: 400 });
      return Response.json({ client_id: `registered-${registrations.length}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" }, { status: 201 });
    }
    if (u.pathname === "/authorize") {
      const registered = registrations.find((_, i) => u.searchParams.get("client_id") === `registered-${i + 1}`);
      if (u.searchParams.get("resource") !== resource || registered && !registered.redirect_uris.includes(u.searchParams.get("redirect_uri"))) return new Response(null, { status: 400 });
      return fetch(`${oauth.url}/authorize${u.search}`, { redirect: "manual" });
    }
    if (u.pathname === "/token") {
      const body = await req.text();
      if (new URLSearchParams(body).get("resource") !== resource) return Response.json({ error: "invalid_target" }, { status: 400 });
      oauth.expiresIn = state.expiresIn;
      return fetch(`${oauth.url}/token`, { method: "POST", headers: req.headers, body });
    }
    seen.push({ method: req.method, token: req.headers.get("authorization"), path: u.pathname });
    if (state.redirect) return new Response(null, { status: 307, headers: { location: state.redirect } });
    if (state.rejectTokens || req.headers.get("authorization") !== `Bearer access-${oauth.issued}` || !oauth.issued) return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/metadata", scope="tools.read tools.call"` } });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (state.legacy && req.method === "GET") return new Response(new ReadableStream({ start(c) { streams.push(c); c.enqueue(encoder.encode(`event: endpoint\ndata: ${state.endpoint}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } });
    const result = handleMcpRequest(await req.json());
    if (state.legacy) {
      if (result) streams.at(-1)?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(result)}\n\n`));
      return new Response(null, { status: 202 });
    }
    return result ? Response.json(result, { headers: { "mcp-session-id": "private-session" } }) : new Response(null, { status: 202 });
  } });
  base = `http://127.0.0.1:${server.port}`;
  return { url: `${base}/mcp`, base, oauth, state, registrations, seen, stop() { server.stop(true); oauth.stop(); } };
}

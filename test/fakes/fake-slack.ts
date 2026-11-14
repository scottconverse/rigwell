import { SlackHub } from "../../src/automations/triggers/slack.ts";
export function fakeSlack() {
  const sockets = new Set<Bun.ServerWebSocket<{}>>(), posts: any[] = [], acks: string[] = [], auth: string[] = []; let opens = 0, connections = 0;
  const server = Bun.serve<{}, {}>({ hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/socket") { if (server.upgrade(req, { data: {} })) return; return new Response("Upgrade", { status: 400 }); }
      auth.push(req.headers.get("authorization") ?? "");
      if (path === "/apps.connections.open") { opens++; return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/socket` }); }
      if (path === "/chat.postMessage") { posts.push(await req.json()); return Response.json({ ok: true, ts: `${Date.now() / 1000}` }); }
      return new Response("No route", { status: 404 });
    }, websocket: { open(ws) { connections++; sockets.add(ws); }, close(ws) { sockets.delete(ws); }, message(_ws, raw) { acks.push(JSON.parse(raw.toString()).envelope_id); } },
  });
  const hub = new SlackHub({ root: `http://127.0.0.1:${server.port}`, allowSocket: (u) => u.origin === `ws://127.0.0.1:${server.port}` });
  return { server, hub, posts, acks, sockets, get opens() { return opens; }, get connections() { return connections; }, auth,
    send(id: string, payload: any) { for (const s of sockets) s.send(JSON.stringify({ envelope_id: id, payload })); },
    event(id: string, text: string, patch: any = {}) { this.send(id, { team_id: "T1", event_id: id, event: { type: "app_mention", user: "U1", channel: "C1", ts: String(Date.now() / 1000), text, ...patch } }); },
    action(id: string, value: string, thread: string, patch: any = {}) { this.send(id, { type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, message: { thread_ts: thread }, actions: [{ value }], ...patch }); },
    stop() { server.stop(true); },
  };
}

import { expect, test } from "bun:test";
import { createAutomationService } from "../../src/automations/index.ts";
import { matchesPattern } from "../../src/automations/triggers/slack.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { FakeClock } from "./helpers.ts";
import { until } from "../workstreams/helpers.ts";

test("Socket Mode shares connections, acknowledges durable events, filters bots/channels/patterns, deduplicates and replies only when enabled", async () => {
  const env = tmpEnv(), clock = new FakeClock(Date.now() - 1000), acknowledgements: string[] = [], posts: any[] = [], auth: string[] = [], sockets = new Set<Bun.ServerWebSocket<{}>>(); let opens = 0, runs = 0;
  const server = Bun.serve<{}, {}>({ hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/socket") { if (server.upgrade(req, { data: {} })) return; return new Response("Upgrade", { status: 400 }); }
      auth.push(req.headers.get("authorization") ?? "");
      if (path === "/apps.connections.open") { opens++; return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/socket` }); }
      if (path === "/chat.postMessage") { posts.push(await req.json()); return Response.json({ ok: true }); }
      return new Response("No route", { status: 404 });
    }, websocket: { open(ws) { sockets.add(ws); }, close(ws) { sockets.delete(ws); }, message(_ws, raw) { acknowledgements.push(JSON.parse(raw.toString()).envelope_id); } },
  });
  const credentials: Record<string, string> = { app: "fake-app-secret", bot: "fake-bot-secret" };
  const options = { clock, runner: async () => { runs++; return { ok: true, text: "Result with fake-bot-secret removed" }; }, triggers: { slack: { root: `http://127.0.0.1:${server.port}`, credential: (name: string) => credentials[name], allowSocket: (url: URL) => url.origin === `ws://127.0.0.1:${server.port}` } } };
  let service = createAutomationService(options);
  const send = (id: string, event: any) => { for (const ws of sockets) ws.send(JSON.stringify({ envelope_id: id, type: "events_api", payload: { event_id: id, team_id: "T1", event: { user: "U1", ts: String((clock.now() + 500) / 1000), channel: "C1", ...event } } })); };
  try {
    const a = service.manager.create({ name: "Direct Slack", trigger: "slack", eventTrigger: { appTokenCredential: "app", botTokenCredential: "bot", events: ["mention", "dm"] } }, "Answer Slack");
    service.manager.create({ name: "Channel Slack", trigger: "slack", eventTrigger: { appTokenCredential: "app", botTokenCredential: "bot", events: ["channel"], channels: ["C1"], pattern: "*please*" } }, "Answer channel");
    await service.triggers.tick(); await until(() => sockets.size === 1);
    send("bot", { type: "app_mention", bot_id: "B1" }); send("wrong-channel", { type: "message", channel: "C2", text: "please" }); send("wrong-pattern", { type: "message", text: "ignore" });
    send("mention", { type: "app_mention", text: "@app hello" }); send("dm", { type: "message", channel: "D1", channel_type: "im", text: "hello" }); send("channel", { type: "message", text: "please help" });
    await until(() => acknowledgements.length === 6);
    for (let i = 0; i < 3; i++) { await service.triggers.tick(); await service.manager.idle(); }
    expect(runs).toBe(3); expect(opens).toBe(1); expect(posts).toEqual([]); expect(auth[0]).toBe("Bearer fake-app-secret");
    service.stop(); await until(() => sockets.size === 0); service = createAutomationService(options);
    await service.triggers.tick(); await until(() => sockets.size === 1); send("mention", { type: "app_mention", text: "replayed" }); await until(() => acknowledgements.length === 7); await service.triggers.tick(); await service.manager.idle(); expect(runs).toBe(3);
    service.manager.update(a.id, { postResult: true }); send("new-mention", { type: "app_mention", text: "new request", thread_ts: "1700000000.123" }); await until(() => acknowledgements.length === 8);
    await service.triggers.tick(); await service.manager.idle(); await service.triggers.tick();
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ channel: "C1", thread_ts: "1700000000.123", mrkdwn: false }); expect(posts[0].text).not.toContain("fake-bot-secret"); expect(auth.at(-1)).toBe("Bearer fake-bot-secret");
    expect(matchesPattern("please help", "*please*")).toBe(true); expect(matchesPattern("no", "*please*")).toBe(false);
  } finally { service.stop(); await service.manager.idle(); server.stop(true); env.cleanup(); }
}, 10_000);

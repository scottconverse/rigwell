import { secretValue } from "../../secrets/store.ts";
import type { SlackTrigger } from "./config.ts";
import type { TriggerEvent } from "./events.ts";
import { apiJson } from "./http.ts";

/** Bounded wildcard matching, without executing a user-supplied regular expression. */
export function matchesPattern(text: string, pattern: string) {
  let i = 0, j = 0, star = -1, back = 0;
  while (i < text.length) {
    if (pattern[j] === "?" || pattern[j] === text[i]) { i++; j++; }
    else if (pattern[j] === "*") { star = j++; back = i; }
    else if (star >= 0) { j = star + 1; i = ++back; }
    else return false;
  }
  while (pattern[j] === "*") j++; return j === pattern.length;
}
export function slackEvent(c: SlackTrigger, payload: any): TriggerEvent | undefined {
  const e = payload?.event;
  if (!e || e.bot_id || e.subtype || !/^[UW][A-Z0-9]+$/.test(e.user ?? "") || !/^[CDG][A-Z0-9]+$/.test(e.channel ?? "") || typeof payload.event_id !== "string") return;
  const kind = e.type === "app_mention" ? "mention" : e.type === "message" && e.channel_type === "im" ? "dm" : e.type === "message" ? "channel" : undefined;
  if (!kind || !c.events.includes(kind) || (c.channels?.length && !c.channels.includes(e.channel)) || !matchesPattern(String(e.text ?? ""), c.pattern ?? "*")) return;
  const at = Number(e.event_ts ?? e.ts) * 1000, thread = e.thread_ts ?? e.ts;
  if (!Number.isFinite(at) || !/^\d+\.\d+$/.test(thread ?? "")) return;
  return { id: `slack:${payload.team_id}:${payload.event_id}`, kind: `slack_${kind}`, at, payload, reply: { service: "slack", channel: e.channel, thread } };
}
export interface SlackDeps { root?: string; fetch?: typeof fetch; socket?: (url: string) => WebSocket; allowSocket?: (url: URL) => boolean; credential?: (name: string) => string | undefined }
export class SlackSocket {
  private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>; private abort = new AbortController(); private stopped = false; private failures = 0;
  constructor(private config: SlackTrigger, private receive: (payload: any) => Promise<void> | void, private report: (message: string) => void, private deps: SlackDeps = {}) {}
  async api(method: string, body: unknown, appToken = false) {
    const key = appToken ? this.config.appTokenCredential : this.config.botTokenCredential, token = (this.deps.credential ?? secretValue)(key);
    if (!token) throw new Error(`Missing stored Slack credential: ${key}`);
    const { body: result } = await apiJson(`${this.deps.root ?? "https://slack.com/api"}/${method}`, token, { method: "POST", body: JSON.stringify(body) }, this.deps.fetch, this.abort.signal);
    if (result.ok !== true) throw new Error(`Slack ${method} failed (${String(result.error ?? "invalid response").slice(0, 80)})`); return result;
  }
  start() { void this.connect(); }
  private retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6))); this.timer.unref?.();
  }
  private async connect() {
    if (this.stopped) return;
    try {
      const { url } = await this.api("apps.connections.open", {}, true); if (this.stopped) return;
      const parsed = new URL(url);
      if (!(this.deps.allowSocket?.(parsed) ?? (parsed.protocol === "wss:" && /^wss-[a-zA-Z0-9-]+\.slack\.com$/.test(parsed.hostname))) || parsed.username || parsed.password) throw new Error("Slack returned an untrusted Socket Mode address");
      const ws = this.socket = (this.deps.socket ?? ((url) => new WebSocket(url)))(url);
      ws.onopen = () => { this.failures = 0; };
      ws.onmessage = async (message) => {
        if (this.stopped || this.socket !== ws) return;
        try {
          if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 256 * 1024) { ws.close(); return; }
          const envelope = JSON.parse(message.data);
          if (envelope.type === "disconnect") { ws.close(); return; }
          if (typeof envelope.envelope_id === "string") {
            // Persist/filter before acknowledging. A failed durable enqueue is retried by Slack.
            await this.receive(envelope.payload);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          }
        } catch { this.report("Slack event could not be saved; it was not acknowledged"); }
      };
      ws.onclose = () => { if (this.socket === ws) { this.socket = undefined; this.retry(); } };
      ws.onerror = () => { this.report("Slack Socket Mode connection failed"); ws.close(); };
    } catch (e) { if (!this.stopped) { this.report((e as Error).message); this.retry(); } }
  }
  async reply(event: TriggerEvent, text: string) {
    const target = event.reply; if (target?.service !== "slack" || !/^[CDG][A-Z0-9]+$/.test(target.channel) || !/^\d+\.\d+$/.test(target.thread)) throw new Error("No verified Slack reply destination");
    await this.api("chat.postMessage", { channel: target.channel, thread_ts: target.thread, text, mrkdwn: false, unfurl_links: false, unfurl_media: false });
  }
  stop() { this.stopped = true; this.abort.abort(); clearTimeout(this.timer); this.socket?.close(); this.socket = undefined; }
}

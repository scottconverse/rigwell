import { constants, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { PhoneStore, phoneInterfaces, sameSecret, validatePhoneConfig, type PhoneConfig } from "./store.ts";
import { MOBILE_HTML, MOBILE_JS } from "./web.ts";

interface Connection { feed(message: string): void; close(): void }
interface SocketData { deviceId: string; credential: string; connection?: Connection; windowAt: number; count: number }
const MOBILE_METHODS = new Set(["initialize", "list_sessions", "load_session", "owned_session_snapshot", "add_user_message", "interrupt_session", "answer_request", "list_workstreams", "get_workstream", "workstream_send", "workstream_answer_request"]);
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
export class PhoneAccess {
  private server?: Bun.Server;
  private sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  private pairing?: { code: string; expiresAt: number };
  private fingerprint?: string;
  private url?: string;
  private attempts = new Map<string, { at: number; count: number }>();
  private generation = 0;
  constructor(readonly store: PhoneStore, private open: (write: (message: string) => void) => Connection, private log?: (m: string) => void) {}
  status() { return { ...this.store.config(), listening: !!this.server, url: this.url, fingerprint: this.fingerprint, interfaces: phoneInterfaces(), devices: this.store.list() }; }
  async restore() { const config = this.store.config(); if (config.remoteAccessEnabled) try { await this.start(config); } catch (e) { this.log?.(`[phone] TLS listener unavailable: ${(e as Error).message}`); } }
  async configure(input: unknown) {
    const config = validatePhoneConfig(input), previous = this.store.config(); this.stop();
    const generation = this.generation;
    try { if (config.remoteAccessEnabled) await this.start(config, generation); }
    catch (e) { if (generation === this.generation && previous.remoteAccessEnabled) await this.start(previous, generation).catch((error) => this.log?.(`[phone] previous listener recovery failed: ${error.message}`)); throw e; }
    this.store.saveConfig(config); return this.status();
  }
  async pair() {
    if (!this.server || !this.url || !this.fingerprint) throw new Error("Enable phone access before pairing a device");
    const code = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 2 * 60_000;
    this.pairing = { code, expiresAt };
    const url = `${this.url}#pair=${code}&fingerprint=${encodeURIComponent(this.fingerprint)}`;
    return { url, code, expiresAt, fingerprint: this.fingerprint, qr: await QRCode.toDataURL(url, { errorCorrectionLevel: "M", width: 320, margin: 2 }) };
  }
  revoke(id: string) { this.store.revoke(id); for (const ws of this.sockets) if (ws.data.deviceId === id) ws.close(1008, "Device revoked"); return this.status(); }
  methods = {
    phone_status: () => this.status(),
    phone_configure: (p: Record<string, unknown>) => this.configure(p.config),
    phone_pair: () => this.pair(),
    phone_revoke: (p: Record<string, unknown>) => { if (typeof p.id !== "string") throw new Error("Device id required"); return this.revoke(p.id); },
  };
  private async body(req: Request): Promise<any> {
    if (!req.body) throw new Error("Body required"); const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) throw new Error("Pairing request is too large"); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    finally { await reader.cancel().catch(() => {}); }
  }
  private async start(config: PhoneConfig, generation = this.generation) {
    const certificate = await this.store.certificate(config.host);
    if (generation !== this.generation) throw new Error("Phone access configuration changed during startup");
    const authorityHost = config.host.includes(":") ? `[${config.host}]` : config.host;
    const sockets = this.sockets, store = this.store, manager = this;
    const server = Bun.serve<SocketData, {}>({
      hostname: config.host, port: config.port, tls: { cert: certificate.cert, key: certificate.key, secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1 },
      async fetch(req, srv) {
        const authority = `${authorityHost}:${srv.port}`, origin = `https://${authority}`, url = new URL(req.url);
        const response = (body: BodyInit | null, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...headers, ...extra } });
        if (req.headers.get("host") !== authority) return response("Forbidden host", 403);
        if (req.method === "GET" && url.pathname === "/") return response(MOBILE_HTML, 200, { "content-type": "text/html; charset=utf-8" });
        if (req.method === "GET" && url.pathname === "/app.js") return response(MOBILE_JS, 200, { "content-type": "application/javascript; charset=utf-8" });
        if (req.headers.get("origin") !== origin) return response("Forbidden origin", 403);
        if (req.method === "POST" && url.pathname === "/pair") {
          const ip = srv.requestIP(req)?.address ?? "unknown", now = Date.now();
          for (const [key, value] of manager.attempts) if (now - value.at > 60_000) manager.attempts.delete(key);
          const rate = manager.attempts.get(ip) ?? { at: now, count: 0 }; rate.count++; manager.attempts.set(ip, rate);
          if (rate.count > 10 || manager.attempts.size > 1000) return response("Try pairing again later", 429);
          if (!req.headers.get("content-type")?.startsWith("application/json")) return response("JSON required", 415);
          try {
            const body = await manager.body(req), pairing = manager.pairing, pairedAt = Date.now();
            if (!pairing || pairing.expiresAt <= pairedAt || typeof body.code !== "string" || !sameSecret(body.code, pairing.code)) return response("Pairing code expired or invalid", 401);
            // Consume before any asynchronous work. A code can create only one device.
            manager.pairing = undefined;
            const { device, credential } = store.createDevice(body.name, certificate.fingerprint, pairedAt);
            return response(JSON.stringify({ paired: true, credential, device: { id: device.id, name: device.name }, fingerprint: certificate.fingerprint }), 200, { "content-type": "application/json" });
          } catch { return response("Invalid pairing request", 400); }
        }
        if (req.method === "GET" && url.pathname === "/rpc") {
          const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(/,\s*/);
          const credential = protocols.find((p) => p.startsWith("rigwell-device."))?.slice(15).replace(".", ":"), device = store.authenticate(credential, Date.now(), certificate.fingerprint);
          if (!device) return response("Pair this device first", 401);
          if (sockets.size >= 64) return response("Too many connections", 429);
          if (!protocols.includes("rigwell")) return response("Protocol required", 400);
          if (srv.upgrade(req, { headers: { "sec-websocket-protocol": "rigwell" }, data: { deviceId: device.id, credential: credential!, windowAt: Date.now(), count: 0 } })) return;
          return response("WebSocket required", 426);
        }
        return response("Not found", 404);
      }, websocket: {
        maxPayloadLength: 256 * 1024, idleTimeout: 120,
        open(ws) { sockets.add(ws); store.seen(ws.data.deviceId); ws.data.connection = manager.open((m) => ws.send(m.trim())); },
        message(ws, raw) {
          if (!store.authenticate(ws.data.credential, Date.now(), certificate.fingerprint)) { ws.close(1008, "Device revoked or expired"); return; }
          const now = Date.now(); if (now - ws.data.windowAt >= 1000) { ws.data.windowAt = now; ws.data.count = 0; }
          if (++ws.data.count > 40) { ws.close(1008, "Too many messages"); return; }
          let message: any; try { message = JSON.parse(String(raw)); } catch { ws.close(1008, "Invalid message"); return; }
          // Responses to harness permission/ask-user requests remain on the same authenticated connection.
          if (!message || Array.isArray(message) || (message.method !== undefined && (typeof message.method !== "string" || !MOBILE_METHODS.has(message.method.replace(/^rigwell\./, ""))))) {
            if (message?.id !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method unavailable on phone access" } })); return;
          }
          ws.data.connection?.feed(JSON.stringify(message));
        },
        close(ws) { sockets.delete(ws); ws.data.connection?.close(); },
      },
    });
    this.server = server; this.url = `https://${authorityHost}:${server.port}/`; this.fingerprint = certificate.fingerprint;
  }
  stop() { this.generation++; this.pairing = undefined; this.server?.stop(true); this.server = undefined; this.url = undefined; this.fingerprint = undefined; }
}

import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpEnv } from "../storage/helpers.ts";
import { PhoneAccess } from "../../src/phone/server.ts";
import { PhoneStore, validatePhoneConfig } from "../../src/phone/store.ts";

test("phone TLS pairs once, binds credentials to identity, blocks cross-origin/admin calls and revokes sockets", async () => {
  const env = tmpEnv(), store = new PhoneStore(), received: any[] = [];
  const access = new PhoneAccess(store, (write) => ({ feed(message) { const m = JSON.parse(message); received.push(m); write(JSON.stringify({ jsonrpc: "2.0", type: "response", id: m.id, result: { ok: true } })); }, close() {} }));
  let ws: any;
  try {
    expect(access.status().remoteAccessEnabled).toBe(false); expect(access.status().listening).toBe(false);
    expect(() => validatePhoneConfig({ remoteAccessEnabled: true, host: "0.0.0.0", port: 0 })).toThrow();
    const status = await access.configure({ remoteAccessEnabled: true, host: "127.0.0.1", port: 0 }), url = status.url!;
    const certificate = await store.certificate("127.0.0.1"), cert = new X509Certificate(certificate.cert);
    expect(cert.verify(cert.publicKey)).toBe(true); expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1"); expect(status.fingerprint).toBe(cert.fingerprint256);
    let untrusted: unknown; try { await fetch(url); } catch (e) { untrusted = e; } expect(untrusted).toBeDefined();
    const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, url), { ...init, tls: { rejectUnauthorized: false } });
    expect((await request("/", { headers: { host: "evil.example" } })).status).toBe(403);
    const pairing = await access.pair(); expect(pairing.qr).toStartWith("data:image/png;base64,"); expect(new URL(pairing.url).hash).toContain(pairing.code); expect(pairing.url).toContain(encodeURIComponent(status.fingerprint!));
    const post = (code: string, origin = url.slice(0, -1)) => request("/pair", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code, name: "Fixture phone" }) });
    expect((await post(pairing.code, "https://evil.example")).status).toBe(403);
    expect((await post("wrong")).status).toBe(401);
    const response = await post(pairing.code), paired = await response.json(); expect(response.status).toBe(200); expect((await post(pairing.code)).status).toBe(401);
    const stored = readFileSync(join(store.root, "devices.json"), "utf8"); expect(stored).not.toContain(paired.credential); expect(JSON.stringify(access.status())).not.toContain(paired.credential);
    expect(store.authenticate(paired.credential, Date.now(), "wrong-identity")).toBeUndefined();
    expect((await request(`/rpc?token=${paired.credential}`, { headers: { origin: url.slice(0, -1) } })).status).toBe(401);
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), WS = require("ws");
    ws = new WS(url.replace("https:", "wss:") + "rpc", ["rigwell", "rigwell-device." + paired.credential.replace(":", ".")], { rejectUnauthorized: false, origin: url.slice(0, -1) });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const call = (method: string) => new Promise<any>((resolve) => { ws.once("message", (b: Buffer) => resolve(JSON.parse(b.toString()))); ws.send(JSON.stringify({ jsonrpc: "2.0", type: "request", id: crypto.randomUUID(), method: `rigwell.${method}`, params: {} })); });
    expect((await call("phone_pair")).error.code).toBe(-32601); expect(received).toHaveLength(0);
    expect((await call("list_sessions")).result.ok).toBe(true); expect(received).toHaveLength(1);
    const closed = new Promise<number>((resolve) => ws.once("close", resolve)); access.revoke(paired.device.id); expect(await closed).toBe(1008);
    expect(store.authenticate(paired.credential)).toBeUndefined();
    expect(access.status().devices[0]!.revokedAt).toBeDefined();
    await access.configure({ remoteAccessEnabled: false, host: "127.0.0.1", port: 0 }); expect(access.status().listening).toBe(false);
  } finally { ws?.terminate(); access.stop(); env.cleanup(); }
}, 10_000);

test("phone restart retains certificate/device identity, expires tokens, replaces codes and bounds pairing attempts", async () => {
  const env = tmpEnv(), store = new PhoneStore(), open = () => ({ feed() {}, close() {} });
  let access = new PhoneAccess(store, open);
  try {
    const identities = await Promise.all([store.certificate("127.0.0.1"), store.certificate("127.0.0.1")]); expect(identities[0].fingerprint).toBe(identities[1].fingerprint);
    const { credential, device } = store.createDevice("Persisted phone", identities[0].fingerprint);
    expect(store.authenticate(credential, device.expiresAt)).toBeUndefined(); expect(store.authenticate(credential, device.expiresAt - 1)).toBeDefined();
    await access.configure({ remoteAccessEnabled: true, host: "127.0.0.1", port: 0 }); const oldCode = (await access.pair()).code;
    access.stop(); access = new PhoneAccess(new PhoneStore(), open); await access.restore();
    expect(access.status().listening).toBe(true); expect(access.status().fingerprint).toBe(identities[0].fingerprint); expect(access.store.authenticate(credential, Date.now(), access.status().fingerprint)).toBeDefined();
    const url = access.status().url!, post = (code: string) => fetch(new URL("pair", url), { method: "POST", tls: { rejectUnauthorized: false }, headers: { origin: url.slice(0, -1), "content-type": "application/json" }, body: JSON.stringify({ code, name: "Replacement" }) });
    expect((await post(oldCode)).status).toBe(401);
    const first = await access.pair(), second = await access.pair(); expect((await post(first.code)).status).toBe(401); expect((await post(second.code)).status).toBe(200);
    for (let i = 0; i < 7; i++) expect((await post("wrong")).status).toBe(401);
    expect((await post((await access.pair()).code)).status).toBe(429);
  } finally { access.stop(); env.cleanup(); }
});

test("stopping phone access during certificate startup prevents an unowned listener", async () => {
  const env = tmpEnv(), store = new PhoneStore(); const certificate = await store.certificate("127.0.0.1");
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  store.certificate = async () => { await waiting; return certificate; };
  const access = new PhoneAccess(store, () => ({ feed() {}, close() {} }));
  try {
    const configuring = access.configure({ remoteAccessEnabled: true, host: "127.0.0.1", port: 0 }); const outcome = configuring.then(() => "unexpected success", (e) => e.message);
    access.stop(); release(); expect(await outcome).toContain("changed during startup"); expect(access.status().listening).toBe(false); expect(access.status().remoteAccessEnabled).toBe(false);
  } finally { release(); access.stop(); env.cleanup(); }
});

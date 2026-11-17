import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { rigwellHome } from "../storage/paths.ts";
import { makePrivate } from "../platform/private.ts";
import { atomicText, unlinkedPath } from "../sync/target.ts";

export interface PhoneConfig { remoteAccessEnabled: boolean; host: string; port: number }
export interface Device { id: string; name: string; tokenHash: string; fingerprint: string; createdAt: number; expiresAt: number; lastSeenAt?: number; revokedAt?: number }
export const phoneRoot = (home = rigwellHome()) => join(home, "remote-access");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function sameSecret(a: string, b: string) { const x = Buffer.from(digest(a)), y = Buffer.from(digest(b)); return timingSafeEqual(x, y); }
export function phoneInterfaces() {
  return [...new Set(Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).filter((r) => !r.address.includes("%") && !r.address.startsWith("fe80:")).map((r) => r.address)))];
}
export function validatePhoneConfig(input: any): PhoneConfig {
  if (!input || typeof input.remoteAccessEnabled !== "boolean" || !isIP(input.host) || ["0.0.0.0", "::", "255.255.255.255"].includes(input.host) || !Number.isInteger(input.port) || input.port < 0 || input.port > 65535) throw new Error("Choose a specific local interface IP and a valid port");
  if (input.remoteAccessEnabled && !phoneInterfaces().includes(input.host)) throw new Error("The selected address does not belong to this machine");
  return { remoteAccessEnabled: input.remoteAccessEnabled, host: input.host, port: input.port };
}
export class PhoneStore {
  readonly root: string;
  private certificates = new Map<string, Promise<{ host: string; cert: string; key: string; fingerprint: string }>>();
  constructor(home = rigwellHome()) { this.root = phoneRoot(home); }
  private read<T>(name: string, fallback: T): T {
    const file = unlinkedPath(join(this.root, name)); if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  private write(name: string, value: unknown) { unlinkedPath(this.root); mkdirSync(this.root, { recursive: true, mode: 0o700 }); makePrivate(this.root, { dir: true }); const file = join(this.root, name); atomicText(file, JSON.stringify(value)); makePrivate(file); }
  config(): PhoneConfig { return this.read("config.json", { remoteAccessEnabled: false, host: "127.0.0.1", port: 47823 }); }
  saveConfig(config: PhoneConfig) { this.write("config.json", validatePhoneConfig(config)); }
  devices(): Device[] {
    const d = this.read<any>("devices.json", []);
    if (!Array.isArray(d) || d.some((v) => typeof v.id !== "string" || typeof v.name !== "string" || !/^[a-f0-9]{64}$/.test(v.tokenHash) || !Number.isFinite(v.expiresAt))) throw new Error("Invalid paired device store");
    return d;
  }
  list() { return this.devices().map(({ tokenHash: _, ...device }) => device); }
  createDevice(name: string, fingerprint: string, now = Date.now()) {
    const devices = this.devices(); if (devices.filter((d) => !d.revokedAt && d.expiresAt > now).length >= 32) throw new Error("Revoke an old device before pairing another");
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error("Choose a device name of at most 80 characters");
    const token = randomBytes(32).toString("base64url"), device: Device = { id: crypto.randomUUID(), name: name.trim(), tokenHash: digest(token), fingerprint, createdAt: now, expiresAt: now + 365 * 24 * 60 * 60_000 };
    devices.push(device); this.write("devices.json", devices); return { device, credential: `${device.id}:${token}` };
  }
  authenticate(credential: string | undefined, now = Date.now(), fingerprint?: string) {
    const match = /^([a-f0-9-]{36}):([A-Za-z0-9_-]{43})$/.exec(credential ?? ""); if (!match) return;
    const device = this.devices().find((d) => d.id === match[1]);
    if (!device || device.revokedAt || device.expiresAt <= now || (fingerprint && device.fingerprint !== fingerprint) || !sameSecret(digest(match[2]!), device.tokenHash)) return;
    return device;
  }
  seen(id: string, now = Date.now()) { const d = this.devices(); const device = d.find((d) => d.id === id); if (device && (!device.lastSeenAt || now - device.lastSeenAt > 60_000)) { device.lastSeenAt = now; this.write("devices.json", d); } }
  revoke(id: string) { const d = this.devices(), device = d.find((d) => d.id === id); if (!device) throw new Error("Unknown paired device"); device.revokedAt = Date.now(); this.write("devices.json", d); }
  certificate(host: string) {
    let pending = this.certificates.get(host);
    if (!pending) { pending = this.loadCertificate(host).finally(() => this.certificates.delete(host)); this.certificates.set(host, pending); }
    return pending;
  }
  private async loadCertificate(host: string) {
    const file = `certificate-${digest(host).slice(0, 16)}.json`;
    let saved = this.read<any>(file, undefined);
    if (saved && saved.host === host) {
      const cert = new X509Certificate(saved.cert);
      if (cert.checkIP(host) && Date.parse(cert.validTo) > Date.now() + 24 * 60 * 60_000) return { ...saved, fingerprint: cert.fingerprint256 };
    }
    const pems = await generate([{ name: "commonName", value: "Rigwell phone access" }], {
      keySize: 2048, algorithm: "sha256", notAfterDate: new Date(Date.now() + 180 * 24 * 60 * 60_000),
      extensions: [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, keyEncipherment: true }, { name: "extKeyUsage", serverAuth: true }, { name: "subjectAltName", altNames: [{ type: 7, ip: host }] }],
    });
    saved = { host, cert: pems.cert, key: pems.private }; this.write(file, saved);
    return { ...saved, fingerprint: new X509Certificate(saved.cert).fingerprint256 };
  }
}

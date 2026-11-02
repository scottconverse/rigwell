// Signed updates for Linux (spec 14.5: "a tarball checked against an embedded Ed25519 public key"). No Electron imports.
//
// The release signature is Ed25519 over the exact bytes of the artifact (AppImage, tarball...). The feed carries it as
// `files[0].signature` (base64) or serves it next to the artifact as `<artifact url>.sig` (base64 text). The public key is
// set by whoever builds or deploys the app, because this repository ships no key:
//   - desktop setting `updatePublicKey` (Settings > General), or the environment variable RIGWELL_UPDATE_PUBLIC_KEY
//   - accepted forms: a PEM public key ("-----BEGIN PUBLIC KEY-----"), base64 of the 32 raw key bytes, or base64 of the DER SPKI
// An artifact is installed only after its signature verifies. No key, no signature, a bad signature, a wrong size or a
// wrong sha512 all refuse the update and nothing is left on disk.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export class UpdateRefused extends Error {
  constructor(message: string, readonly reason: "no-key" | "bad-key" | "unsigned" | "bad-signature" | "bad-hash" | "download") { super(message); }
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** Parses the configured public key. Throws UpdateRefused("bad-key") when it is not an Ed25519 public key. */
export function parsePublicKey(text: string | undefined): KeyObject {
  const t = (text ?? "").trim();
  if (!t) throw new UpdateRefused("No update public key is configured, so updates cannot be verified. Set updatePublicKey in Settings > General (see docs/desktop.md).", "no-key");
  try {
    let key: KeyObject;
    if (t.startsWith("-----BEGIN")) key = createPublicKey(t);
    else {
      const raw = Buffer.from(t, "base64");
      key = raw.length === 32 ? createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" }) : createPublicKey({ key: raw, format: "der", type: "spki" });
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    return key;
  } catch (e) {
    throw new UpdateRefused(`The update public key is not a valid Ed25519 public key (${(e as Error).message}).`, "bad-key");
  }
}

/** True when `sigB64` is a valid Ed25519 signature of `data` under `key`. */
export function verifySignature(data: Uint8Array, sigB64: string, key: KeyObject): boolean {
  const sig = Buffer.from(sigB64.trim(), "base64");
  if (sig.length !== 64) return false;
  try { return verify(null, data, key, sig); } catch { return false; }
}

export interface DownloadOptions {
  url: string;
  publicKey: string | undefined;
  /** Signature from the feed (base64); otherwise `<url>.sig` is fetched. */
  signature?: string;
  sha512?: string; // base64 (electron-builder) or hex
  size?: number;
  destDir: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function fetchBytes(fetchFn: typeof fetch, url: string, timeoutMs: number, limit: number): Promise<Buffer> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new UpdateRefused(`The download answered HTTP ${res.status}.`, "download");
  if (Number(res.headers.get("content-length") ?? 0) > limit) throw new UpdateRefused("The download is larger than the allowed size.", "download");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new UpdateRefused("The download is larger than the allowed size.", "download");
  return buf;
}

/** Downloads the artifact, verifies it, and returns its path. Nothing remains on disk when verification fails. */
export async function downloadAndVerify(o: DownloadOptions): Promise<{ path: string; size: number }> {
  const key = parsePublicKey(o.publicKey); // refuse before downloading anything
  const f = o.fetchFn ?? fetch;
  let sig = o.signature;
  if (!sig) {
    try { sig = (await fetchBytes(f, o.url + ".sig", 30_000, 4096)).toString("utf8"); } catch { sig = undefined; }
  }
  if (!sig?.trim()) throw new UpdateRefused("This update has no signature, so it was not installed.", "unsigned");
  const data = await fetchBytes(f, o.url, o.timeoutMs ?? 10 * 60_000, MAX_ARTIFACT_BYTES);
  if (o.size !== undefined && o.size !== data.length) throw new UpdateRefused("The downloaded file has a different size than the feed says.", "bad-hash");
  if (o.sha512) {
    const d = createHash("sha512").update(data).digest();
    if (o.sha512 !== d.toString("base64") && o.sha512.toLowerCase() !== d.toString("hex")) throw new UpdateRefused("The downloaded file does not match the feed's sha512.", "bad-hash");
  }
  if (!verifySignature(data, sig, key)) throw new UpdateRefused("The update's signature does not verify against the configured public key, so it was not installed.", "bad-signature");
  mkdirSync(o.destDir, { recursive: true });
  const name = basename(new URL(o.url).pathname).replace(/[^A-Za-z0-9._-]/g, "_") || "update.bin";
  const dest = join(o.destDir, name);
  const tmp = dest + ".part";
  try { writeFileSync(tmp, data, { mode: 0o755 }); renameSync(tmp, dest); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return { path: dest, size: data.length };
}

/** Replaces a running AppImage with a verified file (same folder, atomic rename). */
export function installAppImage(verified: string, appImagePath: string): string {
  const staged = appImagePath + ".new";
  writeFileSync(staged, readFileSync(verified), { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, appImagePath);
  return appImagePath;
}

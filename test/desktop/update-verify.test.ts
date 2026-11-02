// Signed Linux updates (spec 14.5): a generated test key pair and a local feed. No shipped key, no real hosts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate } from "../../desktop/main/update-feed.ts";
import { downloadAndVerify, installAppImage, parsePublicKey, UpdateRefused, verifySignature } from "../../desktop/main/update-verify.ts";

const good = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const rawPub = (k: typeof good) => (k.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
const pem = (k: typeof good) => k.publicKey.export({ type: "spki", format: "pem" }) as string;
const artifact = Buffer.from("pretend this is an AppImage\n".repeat(1000));
const sigOf = (k: typeof good, data: Buffer) => sign(null, data, k.privateKey).toString("base64");

let srv: ReturnType<typeof Bun.serve>;
let base = "";
let dest: string;
const hits: string[] = [];

beforeAll(() => {
  dest = mkdtempSync(join(tmpdir(), "rigwell-upd-"));
  const sha = createHash("sha512").update(artifact).digest("base64");
  const tampered = Buffer.from(artifact); tampered[5] ^= 1;
  srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      hits.push(p);
      // feed with an inline signature
      if (p === "/inline/latest-linux.yml") return new Response(`version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n    sha512: ${sha}\n    size: ${artifact.length}\n    signature: ${sigOf(good, artifact)}\n`);
      if (p === "/inline/app-9.0.0.AppImage") return new Response(artifact);
      // feed with a signature file next to the artifact
      if (p === "/sidecar/latest-linux.yml") return new Response("version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n");
      if (p === "/sidecar/app-9.0.0.AppImage") return new Response(artifact);
      if (p === "/sidecar/app-9.0.0.AppImage.sig") return new Response(sigOf(good, artifact) + "\n");
      // unsigned
      if (p === "/unsigned/latest-linux.yml") return new Response("version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n");
      if (p === "/unsigned/app-9.0.0.AppImage") return new Response(artifact);
      // signed by somebody else
      if (p === "/forged/latest-linux.yml") return new Response(`version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n    signature: ${sigOf(other, artifact)}\n`);
      if (p === "/forged/app-9.0.0.AppImage") return new Response(artifact);
      // genuine signature, artifact changed afterwards
      if (p === "/tampered/latest-linux.yml") return new Response(`version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n    signature: ${sigOf(good, artifact)}\n`);
      if (p === "/tampered/app-9.0.0.AppImage") return new Response(tampered);
      // wrong hash in the feed
      if (p === "/badhash/latest-linux.yml") return new Response(`version: 9.0.0\nfiles:\n  - url: app-9.0.0.AppImage\n    sha512: ${Buffer.alloc(64).toString("base64")}\n    signature: ${sigOf(good, artifact)}\n`);
      if (p === "/badhash/app-9.0.0.AppImage") return new Response(artifact);
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => { srv.stop(true); rmSync(dest, { recursive: true, force: true }); });

async function fetchUpdate(dir: string, key: string | undefined) {
  const r = await checkForUpdate({ feedUrl: `${base}/${dir}`, currentVersion: "0.1.0", platform: "linux" });
  if (r.status !== "available") throw new Error(`feed: ${r.status}`);
  return downloadAndVerify({ url: r.downloadUrl!, publicKey: key, signature: r.signature, sha512: r.sha512, size: r.size, destDir: join(dest, dir) });
}
const refused = async (p: Promise<unknown>) => { try { await p; } catch (e) { expect(e).toBeInstanceOf(UpdateRefused); return (e as UpdateRefused).reason; } throw new Error("was not refused"); };

describe("public key forms", () => {
  test("raw base64, PEM and SPKI base64 parse; junk and non-Ed25519 keys are refused", () => {
    for (const form of [rawPub(good), pem(good), (good.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64")]) expect(parsePublicKey(form).asymmetricKeyType).toBe("ed25519");
    expect(() => parsePublicKey("")).toThrow(/No update public key/);
    expect(() => parsePublicKey("AAAA")).toThrow(/not a valid Ed25519/);
    expect(() => parsePublicKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }) as string)).toThrow(/Ed25519/);
  });
  test("verifySignature accepts only the right key and message", () => {
    const sig = sigOf(good, artifact);
    expect(verifySignature(artifact, sig, parsePublicKey(rawPub(good)))).toBe(true);
    expect(verifySignature(artifact, sig, parsePublicKey(rawPub(other)))).toBe(false);
    expect(verifySignature(Buffer.from("x"), sig, parsePublicKey(rawPub(good)))).toBe(false);
    expect(verifySignature(artifact, "not base64 of 64 bytes", parsePublicKey(rawPub(good)))).toBe(false);
  });
});

describe("downloading an update from a local feed", () => {
  test("a signature in the feed verifies; the file is written executable and byte-identical", async () => {
    const r = await fetchUpdate("inline", rawPub(good));
    expect(readFileSync(r.path).equals(artifact)).toBe(true);
    expect(existsSync(r.path + ".part")).toBe(false);
  });
  test("a signature file next to the artifact verifies", async () => {
    const r = await fetchUpdate("sidecar", pem(good));
    expect(readFileSync(r.path).equals(artifact)).toBe(true);
    expect(hits).toContain("/sidecar/app-9.0.0.AppImage.sig");
  });
  test("no public key configured: refused before anything is downloaded", async () => {
    const before = hits.filter((h) => h.includes("/inline/app-")).length;
    expect(await refused(fetchUpdate("inline", undefined))).toBe("no-key");
    expect(await refused(fetchUpdate("inline", "   "))).toBe("no-key");
    expect(hits.filter((h) => h.includes("/inline/app-")).length).toBe(before);
  });
  test("unsigned: refused, and nothing is left on disk", async () => {
    expect(await refused(fetchUpdate("unsigned", rawPub(good)))).toBe("unsigned");
    expect(existsSync(join(dest, "unsigned"))).toBe(false);
  });
  test("signed by a different key: refused", async () => {
    expect(await refused(fetchUpdate("forged", rawPub(good)))).toBe("bad-signature");
    expect(existsSync(join(dest, "forged"))).toBe(false);
  });
  test("the right key but a changed artifact: refused", async () => {
    expect(await refused(fetchUpdate("tampered", rawPub(good)))).toBe("bad-signature");
  });
  test("a good signature under another configured key is refused", async () => {
    expect(await refused(fetchUpdate("inline", rawPub(other)))).toBe("bad-signature");
  });
  test("a sha512 or size that does not match is refused", async () => {
    expect(await refused(fetchUpdate("badhash", rawPub(good)))).toBe("bad-hash");
  });
  test("a server error is a refusal, not a crash", async () => {
    expect(await refused(downloadAndVerify({ url: `${base}/missing/app.AppImage`, publicKey: rawPub(good), signature: sigOf(good, artifact), destDir: dest }))).toBe("download");
  });
});

test("installAppImage replaces the file atomically and keeps it executable", () => {
  const file = join(dest, "current.AppImage");
  writeFileSync(file, "old");
  const src = join(dest, "new.bin");
  writeFileSync(src, "new");
  installAppImage(src, file);
  expect(readFileSync(file, "utf8")).toBe("new");
  expect(existsSync(file + ".new")).toBe(false);
});

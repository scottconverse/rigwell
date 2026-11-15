import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareFeed } from "../../desktop/packaging/prepare-feed.ts";
import { RELEASE_FEED_URL, WINDOWS_PUBLISHER } from "../../desktop/main/release-config.ts";
import { DEFAULT_SETTINGS } from "../../desktop/main/settings.ts";
import { checkForUpdate, feedDocumentUrl } from "../../desktop/main/update-feed.ts";
import { downloadAndVerify, installLinuxUpdate, rollbackAppImage } from "../../desktop/main/update-verify.ts";
import { linuxReleaseTarball } from "../../desktop/main/linux-release.ts";

test("release defaults use platform documents on GitHub, retain explicit disabled feeds and pin the signing publisher", () => {
  expect(DEFAULT_SETTINGS.updateFeedUrl).toBe(RELEASE_FEED_URL);
  expect(feedDocumentUrl(RELEASE_FEED_URL, "win32")).toBe(RELEASE_FEED_URL + "/latest.yml");
  expect(WINDOWS_PUBLISHER).toBe("CN=Scott Converse, O=Scott Converse, L=Longmont, S=co, C=US");
});

test("final-byte feed generation recomputes signed installer hashes and requires a macOS ZIP", () => {
  const root = mkdtempSync(join(tmpdir(), "rigwell-feed-")), file = join(root, "setup.exe"); writeFileSync(file, "unsigned fixture");
  const first = prepareFeed("win32", "1.0.0", [file]); writeFileSync(file, "signed fixture with changed bytes"); const final = prepareFeed("win32", "1.0.0", [file]);
  expect(final.files[0]!.sha512).not.toBe(first.files[0]!.sha512); expect(final.files[0]!.sha512).toBe(createHash("sha512").update(readFileSync(file)).digest("base64"));
  const dmg = join(root, "app.dmg"), zip = join(root, "app.zip"); writeFileSync(dmg, "dmg"); writeFileSync(zip, "zip");
  expect(() => prepareFeed("darwin", "1.0.0", [dmg])).toThrow("ZIP"); expect(prepareFeed("darwin", "1.0.0", [dmg, zip]).files[0]!.url).toBe("app.zip");
  expect(() => prepareFeed("linux", "1.0.0", [file])).toThrow("extension"); expect(() => prepareFeed("win32", "bad", [file])).toThrow("semantic version");
});

test("local signed release feed drives download, install, upgrade and local rollback without a remote downgrade", async () => {
  const root = mkdtempSync(join(tmpdir(), "rigwell-release-flow-")), v1 = join(root, "one.tar.gz"), v2 = join(root, "two.tar.gz"), installed = join(root, "installed.AppImage");
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const [file, bytes] of [[v1, "release one"], [v2, "release two"]]) { const archive = linuxReleaseTarball(Buffer.from(bytes!)); writeFileSync(file!, archive); writeFileSync(file! + ".sig", sign(null, archive, keys.privateKey).toString("base64")); }
  let version = "1.0.0", artifact = v1;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { if (new URL(req.url).pathname === "/latest-linux.yml") return Response.json(prepareFeed("linux", version, [artifact])); return new Response(readFileSync(artifact)); } });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    writeFileSync(installed, "initial install");
    const apply = async (currentVersion: string) => { const offer = await checkForUpdate({ feedUrl: url, currentVersion, platform: "linux" }); expect(offer.status).toBe("available"); if (offer.status !== "available") throw new Error("missing offer"); const verified = await downloadAndVerify({ url: offer.downloadUrl!, publicKey, signature: offer.signature, sha512: offer.sha512, size: offer.size, destDir: join(root, "downloads") }); installLinuxUpdate(verified.path, installed); };
    await apply("0.0.0"); expect(readFileSync(installed, "utf8")).toBe("release one");
    artifact = v2; version = "2.0.0"; await apply("1.0.0"); expect(readFileSync(installed, "utf8")).toBe("release two");
    rollbackAppImage(installed); expect(readFileSync(installed, "utf8")).toBe("release one");
    version = "1.0.0"; artifact = v1; expect((await checkForUpdate({ feedUrl: url, currentVersion: "2.0.0", platform: "linux" })).status).toBe("up-to-date");
  } finally { server.stop(true); }
});

// Actual packaged AppImages through a loopback feed, using a disposable test key.
// Exercises release transport/install/rollback and launches each resulting binary.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkForUpdate } from "../main/update-feed.ts";
import { downloadAndVerify, installLinuxUpdate, rollbackAppImage } from "../main/update-verify.ts";
import { linuxReleaseTarball } from "../main/linux-release.ts";
import { prepareFeed } from "./prepare-feed.ts";

if (process.env.CI !== "true" || process.platform !== "linux") throw new Error("Packaged Linux acceptance requires an isolated Linux CI runner");
const [baseline, candidate, output] = process.argv.slice(2).map(value => resolve(value));
if (!baseline || !candidate || !output) throw new Error("Provide baseline AppImage, candidate AppImage and receipt path");
const root = mkdtempSync(join(tmpdir(), "rigwell-package-update-"));
const candidateVersion = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version as string;
const installed = join(root, "Rigwell.AppImage"), archive = join(root, "release.tar.gz");
const oldBytes = readFileSync(baseline), newBytes = readFileSync(candidate);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
assert.notEqual(hash(oldBytes), hash(newBytes), "Use distinct real package builds");
copyFileSync(baseline, installed); chmodSync(installed, 0o755);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicText = publicKey.export({ type: "spki", format: "pem" }).toString();
const bytes = linuxReleaseTarball(newBytes);
writeFileSync(archive, bytes); writeFileSync(archive + ".sig", sign(null, bytes, privateKey).toString("base64"));
const feed = prepareFeed("linux", candidateVersion, [archive]);
let offeredVersion = candidateVersion;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/latest-linux.yml") return Response.json({ ...feed, version: offeredVersion });
  if (path === "/release.tar.gz") return new Response(bytes);
  return new Response("Not found", { status: 404 });
} });
const receipts: Record<string, unknown>[] = [];
function launch(version: string, stage: string) {
  const directory = join(root, stage); mkdirSync(directory);
  const extracted = spawnSync(installed, ["--appimage-extract"], { cwd: directory, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(extracted.status, 0, `Extract ${stage}: ${extracted.stderr}`);
  const receipt = join(directory, "acceptance.json");
  const run = spawnSync(process.execPath, [join(import.meta.dir, "accept-install.ts"), join(directory, "squashfs-root/rigwell"), receipt, version], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, `Launch ${stage}: ${run.stdout}\n${run.stderr}`);
  receipts.push({ stage, ...JSON.parse(readFileSync(receipt, "utf8")) });
  console.log(`[packaged update] ${stage} ${version} PASS`);
}
try {
  launch("0.1.0", "baseline");
  const available = await checkForUpdate({ feedUrl: server.url.toString(), currentVersion: "0.1.0", platform: "linux" });
  assert.equal(available.status, "available");
  if (available.status !== "available" || !available.downloadUrl) throw new Error("Missing real package offer");
  const downloaded = await downloadAndVerify({ url: available.downloadUrl, publicKey: publicText, signature: available.signature, sha512: available.sha512, size: available.size, destDir: join(root, "download") });
  installLinuxUpdate(downloaded.path, installed);
  assert.equal(hash(readFileSync(installed)), hash(newBytes));
  assert.equal(hash(readFileSync(installed + ".previous")), hash(oldBytes));
  launch(candidateVersion, "upgraded");
  offeredVersion = "0.1.0";
  assert.equal((await checkForUpdate({ feedUrl: server.url.toString(), currentVersion: candidateVersion, platform: "linux" })).status, "up-to-date");
  rollbackAppImage(installed);
  assert.equal(hash(readFileSync(installed)), hash(oldBytes));
  launch("0.1.0", "rolled-back");
  writeFileSync(output, JSON.stringify({ status: "PASS", baselineSha256: hash(oldBytes), candidateSha256: hash(newBytes), feed: "loopback", signingKey: "disposable test key; production key never enters CI", nativeUpdateDialog: "not exercised", remoteDowngradeRefused: true, receipts }, null, 2) + "\n");
} finally { server.stop(true); }

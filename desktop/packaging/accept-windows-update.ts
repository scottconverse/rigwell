// Signed installer acceptance on a disposable Windows runner. No real providers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkForUpdate } from "../main/update-feed.ts";
import { verifyWindowsUpdate, guardWindowsInstallation } from "../main/windows-update.ts";
import { prepareFeed } from "./prepare-feed.ts";

if (process.env.CI !== "true" || process.platform !== "win32") throw new Error("Signed acceptance requires an isolated Windows CI runner");
const [oldFolder, newFolder, output] = process.argv.slice(2).map(value => resolve(value));
if (!oldFolder || !newFolder || !output) throw new Error("Provide baseline/candidate signed artifact folders and receipt path");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function signed(folder: string) {
  const receipt = JSON.parse(readFileSync(join(folder, "signing-receipt.json"), "utf8"));
  assert.equal(receipt.status, "Valid");
  assert.match(receipt.file, /^[A-Za-z0-9._-]+\.exe$/);
  const file = join(folder, receipt.file), bytes = readFileSync(file);
  assert.equal(hash(bytes), receipt.signed_sha256);
  assert.equal(bytes.length, receipt.signed_bytes);
  verifyWindowsUpdate(file);
  return { file, bytes, sha256: receipt.signed_sha256, signingRun: receipt.workflow_run };
}
const baseline = signed(oldFolder), candidate = signed(newFolder);
assert.notEqual(baseline.sha256, candidate.sha256);
const root = mkdtempSync(join(tmpdir(), "rigwell-signed-update-")), destination = join(root, "installed");
const version = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version as string;
const feed = prepareFeed("win32", version, [candidate.file]);
let offeredVersion = version;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/latest.yml") return Response.json({ ...feed, version: offeredVersion });
  if (path === "/" + feed.files[0]!.url) return new Response(candidate.bytes);
  return new Response("Not found", { status: 404 });
} });
const receipts: unknown[] = [];
function install(file: string, expectedVersion: string, stage: string) {
  verifyWindowsUpdate(file);
  const system = process.env.SystemRoot || "C:\\Windows";
  const code = "$ErrorActionPreference='Stop'; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $p=Start-Process -FilePath $r.file -ArgumentList '/S',('/D='+$r.destination) -PassThru -Wait -WindowStyle Hidden; exit $p.ExitCode";
  const installed = spawnSync(join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", code], { input: JSON.stringify({ file, destination }), encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(installed.status, 0, `Install ${stage}: ${installed.stderr}`);
  const receiptPath = join(root, stage + ".json");
  const run = spawnSync(process.execPath, [join(import.meta.dir, "accept-install.ts"), join(destination, "rigwell.exe"), receiptPath, expectedVersion, ...(expectedVersion === version ? ["--require-eval-tasks"] : [])], { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, `Launch ${stage}: ${run.stdout}\n${run.stderr}`);
  receipts.push({ stage, ...JSON.parse(readFileSync(receiptPath, "utf8")) });
  console.log(`[signed packaged update] ${stage} ${expectedVersion} PASS`);
}
try {
  install(baseline.file, "0.1.0", "baseline");
  const available = await checkForUpdate({ feedUrl: server.url.toString(), currentVersion: "0.1.0", platform: "win32" });
  if (available.status !== "available" || !available.downloadUrl) throw new Error("No candidate offer");
  const downloaded = Buffer.from(await (await fetch(available.downloadUrl, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  assert.equal(downloaded.length, available.size);
  assert.equal(createHash("sha512").update(downloaded).digest("base64"), available.sha512);
  const downloadDir = join(root, "downloads"); mkdirSync(downloadDir);
  const file = join(downloadDir, "candidate.exe"); writeFileSync(file, downloaded);
  let listener!: (event: { downloadedFile: string }) => void, allowed = false;
  const updater = { autoInstallOnAppQuit: true, on(_event: "update-downloaded", callback: typeof listener) { listener = callback; }, quitAndInstall() { allowed = true; } };
  guardWindowsInstallation(updater, error => { throw error; });
  listener({ downloadedFile: file }); assert.equal(allowed, true); assert.equal(updater.autoInstallOnAppQuit, false);
  install(file, version, "upgraded");
  offeredVersion = "0.1.0";
  assert.equal((await checkForUpdate({ feedUrl: server.url.toString(), currentVersion: version, platform: "win32" })).status, "up-to-date");
  install(baseline.file, "0.1.0", "rolled-back");
  writeFileSync(output, JSON.stringify({ status: "PASS", baselineSha256: baseline.sha256, candidateSha256: candidate.sha256, baselineSigningRun: baseline.signingRun, candidateSigningRun: candidate.signingRun, feed: "loopback", nativeUpdaterDialog: "not exercised; real signature gate and NSIS installation exercised", remoteDowngradeRefused: true, receipts }, null, 2) + "\n");
} finally { server.stop(true); }

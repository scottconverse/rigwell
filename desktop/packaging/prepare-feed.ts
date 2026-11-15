// Regenerate metadata from final bytes, including after Authenticode signing. No upload.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { dump } from "js-yaml";
import { compareVersions } from "../main/update-feed.ts";

export function prepareFeed(platform: string, version: string, artifacts: string[], releaseDate = new Date().toISOString()) {
  if (!["win32", "darwin", "linux"].includes(platform)) throw new Error("Unknown release platform");
  compareVersions(version, version);
  if (!artifacts.length || artifacts.length > 16) throw new Error("Provide final release artifacts");
  const paths = artifacts.map((file) => resolve(file));
  if (new Set(paths).size !== paths.length || paths.some((file) => dirname(file) !== dirname(paths[0]!))) throw new Error("Use distinct artifacts in one release directory");
  const accepted = platform === "win32" ? /\.exe$/i : platform === "darwin" ? /\.(zip|dmg)$/i : /\.(AppImage|tar\.gz)$/i;
  if (paths.some((file) => !accepted.test(file))) throw new Error("Artifact extension does not match the platform");
  if (platform === "win32" && paths.length !== 1) throw new Error("Use one Windows installer");
  if (platform === "darwin" && !paths.some((file) => file.endsWith(".zip"))) throw new Error("macOS updates require a ZIP");
  paths.sort((a, b) => Number(b.endsWith(".zip")) - Number(a.endsWith(".zip")) || Number(b.endsWith(".AppImage")) - Number(a.endsWith(".AppImage")));
  const files = paths.map((file) => {
    const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error("Release artifacts must be regular files without links");
    const data = readFileSync(file), base = { url: basename(file), size: data.length, sha512: createHash("sha512").update(data).digest("base64") };
    if (platform !== "linux") return base;
    const signatureFile = file + ".sig", sigStat = lstatSync(signatureFile);
    if (!sigStat.isFile() || sigStat.isSymbolicLink() || sigStat.size > 4096) throw new Error("Invalid Linux signature file");
    const signature = readFileSync(signatureFile, "utf8").trim();
    if (Buffer.from(signature, "base64").length !== 64) throw new Error("Linux artifacts need an Ed25519 signature");
    return { ...base, signature };
  });
  return { version, releaseDate, files, path: files[0]!.url, sha512: files[0]!.sha512 };
}

if (import.meta.main) {
  try {
    const [platform, version, ...artifacts] = process.argv.slice(2);
    const feed = prepareFeed(platform!, version!, artifacts);
    const target = join(dirname(resolve(artifacts[0]!)), platform === "linux" ? "latest-linux.yml" : platform === "darwin" ? "latest-mac.yml" : "latest.yml");
    try { const s = lstatSync(target); if (!s.isFile() || s.isSymbolicLink()) throw new Error("Feed destination must be a regular file without a link"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    writeFileSync(target, dump(feed)); console.log(target);
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}

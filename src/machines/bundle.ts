// A remote build carries only code, runtime dependencies and a pinned runtime, never user settings.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { RemotePlatform } from "./store.ts";

export const REMOTE_BUN_VERSION = "1.4.4";
export type RuntimeFetch = (input: string | URL, init: RequestInit) => Promise<Response>;
interface Archive { bytes(): Promise<Uint8Array>; files(): Promise<Map<string, File>> }
// The repository's older Bun type package predates the runtime's native archive API.
export const NativeArchive = (Bun as unknown as { Archive: new (files: Uint8Array | Record<string, Uint8Array | string>) => Archive }).Archive;
const digest = (data: Uint8Array | string, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");

async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Runtime download failed (${response.status})`);
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Runtime download is too large");
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error("Empty runtime download");
  const reader = response.body.getReader();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Runtime download is too large"); chunks.push(value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function runtimeFor(platform: RemotePlatform, arch: "x64" | "arm64", fetcher: RuntimeFetch = fetch): Promise<Uint8Array> {
  if (platform === process.platform && arch === process.arch && Bun.version === REMOTE_BUN_VERSION) return readFileSync(process.execPath);
  const target = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "aarch64" : "x64"}`;
  const metadata = await boundedResponse(await fetcher(`https://registry.npmjs.org/@oven/bun-${target}/${REMOTE_BUN_VERSION}`, { redirect: "error", signal: AbortSignal.timeout(30_000) }), 256_000);
  const info = JSON.parse(Buffer.from(metadata).toString("utf8"));
  const url = new URL(info.dist?.tarball ?? "");
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.port) throw new Error("Invalid runtime registry download URL");
  const integrity = info.dist?.integrity;
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error("Missing pinned runtime integrity");
  const bytes = await boundedResponse(await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(120_000) }), 150_000_000);
  if (createHash("sha512").update(bytes).digest("base64") !== integrity.slice(7)) throw new Error("Runtime integrity mismatch");
  const files = await new NativeArchive(bytes).files();
  const executable = files.get(platform === "win32" ? "package/bin/bun.exe" : "package/bin/bun");
  if (!executable || executable.size > 300_000_000) throw new Error("Runtime archive has no expected executable");
  return new Uint8Array(await executable.arrayBuffer());
}

export async function buildRemoteBundle(opts: { platform: RemotePlatform; arch: "x64" | "arm64"; root?: string; runtime?: Uint8Array; fetcher?: RuntimeFetch }) {
  const root = opts.root ?? join(import.meta.dir, "../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files: Record<string, Uint8Array | string> = {};
  const excluded = new Set([".bin", ".cache", ".git", "node_modules"]);
  function collect(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      if (excluded.has(name)) continue;
      const full = join(dir, name), info = lstatSync(full), path = `${prefix}/${name}`;
      if (info.isSymbolicLink()) throw new Error(`Remote build refuses linked source: ${path}`);
      if (info.isDirectory()) collect(full, path);
      else if (info.isFile()) files[path] = readFileSync(full);
    }
  }
  collect(join(root, "src"), "src");
  const visited = new Set<string>();
  function dependency(name: string, parent: string, optional = false) {
    let cursor = parent, directory = "";
    for (;;) {
      const candidate = join(cursor, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) { directory = candidate; break; }
      if (cursor === root) break;
      const next = dirname(cursor); if (next === cursor || relative(root, next).startsWith("..")) break; cursor = next;
    }
    if (!directory) { if (optional) return; throw new Error(`Missing runtime dependency: ${name}`); }
    if (visited.has(directory)) return; visited.add(directory);
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Remote build refuses linked dependency: ${name}`);
    collect(directory, relative(root, directory).split(sep).join("/"));
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    for (const child of Object.keys(metadata.dependencies ?? {})) dependency(child, directory);
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) dependency(child, directory, true);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) dependency(name, root);
  files["package.json"] = JSON.stringify({ name: "rigwell-remote", version: pkg.version, type: "module", dependencies: pkg.dependencies });
  files[opts.platform === "win32" ? "bun.exe" : "bun"] = opts.runtime ?? await runtimeFor(opts.platform, opts.arch, opts.fetcher);
  const hashes = Object.fromEntries(Object.keys(files).sort().map((key) => [key, digest(files[key]!)]));
  const build = digest(JSON.stringify(hashes));
  files["remote-build.json"] = JSON.stringify({ build, version: pkg.version, runtime: REMOTE_BUN_VERSION, platform: opts.platform, arch: opts.arch, hashes });
  return { build, version: String(pkg.version), bytes: await new NativeArchive(files).bytes() };
}

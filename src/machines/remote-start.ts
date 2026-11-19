// Entry point copied inside an immutable, content-identified remote build.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SocketTransport } from "../sdk/transport.ts";
import { RpcClient } from "../sdk/client.ts";
import { remoteSocketPath } from "./endpoint.ts";
import { makePrivate } from "../platform/private.ts";
import { launchDetachedDaemon } from "./detached.ts";
import { withStartupLock } from "./startup-lock.ts";

export async function startRemoteBuild(root: string, expectedBuild: string) {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(join(root, "remote-build.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(expectedBuild) || manifest.build !== expectedBuild) throw new Error("Remote manifest is not the requested build");
  if (manifest.runtime !== Bun.version || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Remote runtime does not match the build manifest");
  if (!manifest.hashes || typeof manifest.hashes !== "object") throw new Error("Missing remote file manifest");
  const hashes = manifest.hashes as Record<string, string>;
  if (createHash("sha256").update(JSON.stringify(hashes)).digest("hex") !== manifest.build) throw new Error("Remote build identity mismatch");
  const checkedDirectories = new Set([root]);
  for (const [path, expected] of Object.entries(hashes)) {
    const target = resolve(root, path), rel = relative(root, target);
    if (isAbsolute(path) || !rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Remote manifest path escaped its build");
    if (!lstatSync(target).isFile()) throw new Error("Remote build contains a non-regular file");
    for (let dir = dirname(target); !checkedDirectories.has(dir); dir = dirname(dir)) {
      if (!lstatSync(dir).isDirectory()) throw new Error("Remote build contains a linked or invalid directory");
      checkedDirectories.add(dir);
    }
    if (createHash("sha256").update(readFileSync(target)).digest("hex") !== expected) throw new Error(`Remote build file mismatch: ${path}`);
  }
  const socket = remoteSocketPath(root, manifest.build, process.platform as "win32" | "linux" | "darwin");
  const socketRoot = dirname(socket);
  mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(socketRoot).isSymbolicLink() || !makePrivate(socketRoot, { dir: true })) throw new Error("Remote socket directory must be private and unlinked");
  const inspect = async () => {
    const client = new RpcClient(await SocketTransport.connect(socket));
    try { const info = await client.request<{ build: string }>("machine_runtime_info"); if (info.build !== manifest.build) throw new Error("Running remote daemon has a different build"); return info; }
    finally { await client.close(); }
  };
  try { return await inspect(); } catch (error) { if (!/ENOENT|ECONNREFUSED/.test(String(error))) throw error; }
  return withStartupLock(root, async () => {
    // A competing bootstrap may have become ready while this caller waited for the OS lock.
    try { return await inspect(); } catch (error) { if (!/ENOENT|ECONNREFUSED/.test(String(error))) throw error; }
    const child = await launchDetachedDaemon(join(root, process.platform === "win32" ? "bun.exe" : "bun"), [join(root, "src/cli/main.ts"), "daemon", "--socket", socket, "--no-ws", "--no-automations", "--no-advertise", "--no-background-services"]);
    try {
      const started = Date.now();
      for (;;) {
        try { return await inspect(); } catch (e) { if (!/ENOENT|ECONNREFUSED/.test(String(e))) throw e; }
        if (await child.exited()) throw new Error("Remote daemon exited before becoming ready");
        if (Date.now() - started > 10_000) throw new Error("Remote daemon did not become ready");
        await Bun.sleep(50);
      }
    } catch (e) { await child.kill(); throw e; }
  });
}
if (import.meta.main) {
  startRemoteBuild(process.argv[2] ?? "", process.argv[3] ?? "").then((info) => console.log(JSON.stringify(info))).catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
}

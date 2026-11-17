import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "../../src/daemon/connection.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import type { Transport } from "../../src/sdk/transport.ts";
import { appendMessage, createSession, loadSession } from "../../src/storage/transcript.ts";
import { tmpEnv } from "../storage/helpers.ts";

test("sharing RPC exports redacted text, imports read-only and requires a separate explicit fork", async () => {
  const env = tmpEnv(), files = createSession({ id: crypto.randomUUID(), cwd: env.root });
  await appendMessage(files, { id: "message", role: "user", content: [{ type: "text", text: "private fixture-value" }] }, null);
  const wire: Transport = { onMessage() {}, onClose() {}, write(line) { connection.peer.feed(line + "\n"); }, async close() { await connection.shutdown(); wire.onClose(); } };
  const connection = createConnection((line) => queueMicrotask(() => wire.onMessage(line.trim())), { canPrompt: true, shareDeps: { secrets: ["fixture-value"] } }), client = new RpcClient(wire);
  let approvals = 0; client.onRequest = () => { approvals++; return { selectedOption: "cancel" }; };
  try {
    const exported = await client.request("export_session", { sessionId: files.id, format: "html" }); expect(exported.content).not.toContain("fixture-value");
    const source = join(env.root, "session.html"); writeFileSync(source, exported.content);
    const imported = await client.request("import_shared_session", { source }); expect(imported.readOnly).toBe(true);
    const view = await client.request("get_shared_session", { importId: imported.importId }); expect(view.readOnly).toBe(true); expect(view.session.messages[0].text).toContain("[redacted]");
    const fork = await client.request("fork_shared_session", { importId: imported.importId, cwd: env.root }); expect(loadSession(fork.sessionId).messages).toHaveLength(1);
    const result = await client.request("share_session", { sessionId: files.id, confirmed: true }); expect(result.shared).toBe(false); expect(approvals).toBe(1);
  } finally { await client.close(); env.cleanup(); }
});

test("CLI export and import preserve files and keep imports separate until --fork", async () => {
  const env = tmpEnv(), files = createSession({ id: crypto.randomUUID(), cwd: env.root, title: "CLI fixture" });
  await appendMessage(files, { id: "message", role: "user", content: [{ type: "text", text: "hello" }] }, null);
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const command = (args: string[]) => new Promise<string>((resolve, reject) => execFile(process.execPath, [cli, ...args], { env: { ...process.env, RIGWELL_CREDENTIALS: "file" }, windowsHide: true, timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  try {
    const file = join(env.root, "shared.md"); expect(JSON.parse(await command(["export", files.id, file])).redacted).toBe(true);
    let refusal: unknown; try { await command(["export", files.id, file]); } catch (e) { refusal = e; } expect(String(refusal)).toContain("EEXIST");
    const imported = JSON.parse(await command(["import", file])); expect(imported.readOnly).toBe(true);
    let missing: unknown; try { loadSession(imported.importId); } catch (e) { missing = e; } expect(String(missing)).toContain("session not found");
    const continued = JSON.parse(await command(["import", file, "--fork", "--cwd", env.root])); expect(loadSession(continued.fork.sessionId).messages).toHaveLength(1);
  } finally { env.cleanup(); }
}, 5000);

import { expect, test } from "bun:test";
import { createConnection } from "../../src/daemon/connection.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import type { Transport } from "../../src/sdk/transport.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SshTransport } from "../../src/machines/ssh.ts";
import { RemoteSessionStore } from "../../src/machines/sessions.ts";

test("selected remote session relays permission prompts and notifications without creating a local session", async () => {
  const env = tmpEnv();
  const fake = await startFakeAnthropic([{ toolCalls: [{ name: "Execute", input: { command: "echo remote fixture > remote.txt", riskLevel: "medium", riskReason: "writes the fixture" } }] }, { text: "Saved the remote fixture" }]);
  const remoteHome = join(env.root, "remote-state"), script = join(env.root, "fake-ssh-session.ts");
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  const calls: string[] = [], events: string[] = [];
  const wire: Transport = { onMessage: () => {}, onClose: () => {}, write(text) { local.peer.feed(text + "\n"); }, async close() { await local.shutdown(); wire.onClose(); } };
  const local = createConnection((line) => queueMicrotask(() => wire.onMessage(line.trim())), { canPrompt: true, connectMachine: async (name) => { calls.push(name); return new RpcClient(new SshTransport({ name, host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })); } });
  const client = new RpcClient(wire);
  let prompts = 0, finished!: () => void;
  const done = new Promise<void>((r) => { finished = r; });
  client.onRequest = (method) => { if (method === "request_permission") prompts++; return { selectedOption: "proceed_once", trust: false }; };
  client.onNotification = (_m, p) => { events.push(p.notification?.type); if (p.notification?.type === "agent_turn_completed") finished(); };
  try {
    const initialized = await client.request<{ machine: string; sessionId: string }>("initialize_session", { machine: "fixture", cwd: env.root, modelId: "custom:Remote-fixture-0", autonomyLevel: "off" });
    expect(initialized.machine).toBe("fixture"); expect(calls).toEqual(["fixture"]); expect(local.session).toBeUndefined();
    await client.request("add_user_message", { text: "Write the fixture" }); await done;
    expect(prompts).toBe(1); expect(events).toContain("assistant_text_delta"); expect(existsSync(join(env.root, "remote.txt"))).toBe(true);
    expect(new RemoteSessionStore().get(initialized.sessionId)?.machine).toBe("fixture");
    let error: any; try { await client.request("load_session", { machine: "other", sessionId: "other" }); } catch (e) { error = e; }
    expect(error?.code).toBe(-32006);
  } finally { await client.close(); fake.stop(); env.cleanup(); }
}, 5000);

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AutomationManager } from "../../src/automations/manager.ts";
import { createHeadlessRunner } from "../../src/automations/runner.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";

test("remote automation uses remote profiles and durable paths, denies approval and closes SSH", async () => {
  const env = tmpEnv(), remoteHome = join(env.root, "remote-home"), cwd = join(env.root, "remote-project");
  mkdirSync(cwd);
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Execute", input: { command: "echo forbidden > forbidden.txt", riskLevel: "medium", riskReason: "fixture write" } }] },
    { text: "Approval denied, continuing without the write." },
    { text: "Second remote run" },
  ]);
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), script = join(env.root, "fake-ssh-automation.ts");
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  const clients: RpcClient[] = [];
  const mgr = new AutomationManager({ runner: createHeadlessRunner({ connectMachine: async (name) => {
    expect(name).toBe("fixture");
    const client = new RpcClient(new SshTransport({ name, host: "owner@fake" }, "fixture", { executable: [process.execPath, script] }));
    clients.push(client); return client;
  } }) });
  try {
    const a = mgr.create({ name: "Remote automation", schedule: "daily", machine: "fixture", workingDirectory: cwd, model: "unavailable-local-profile", autonomy: "off" }, "Inspect the remote project.");
    const first = await mgr.run(a.id).done;
    expect(first.status).toBe("success");
    expect(first.modelFallback?.used).toBe("custom:Remote-fixture-0");
    expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
    const workspace = join(remoteHome, "automation-workspaces", createHash("sha256").update(a.id).digest("hex"));
    const messages = JSON.stringify(fake.requests[0].messages);
    expect(messages).toContain(join(workspace, "memory").replaceAll("\\", "\\\\"));
    expect(messages).not.toContain(a.dir.replaceAll("\\", "\\\\"));
    expect(JSON.stringify(fake.requests[1].messages)).toMatch(/denied|not allowed|permission/i);
    writeFileSync(join(workspace, "memory", "note.txt"), "persistent remote note");
    expect((await mgr.run(a.id).done).status).toBe("success");
    expect(readFileSync(join(workspace, "memory", "note.txt"), "utf8")).toBe("persistent remote note");
    expect(clients.every((c) => c.isClosed)).toBe(true);
    expect(existsSync(join(a.dir, "reports", first.reportFile!))).toBe(true);
  } finally { for (const c of clients) if (!c.isClosed) await c.close(); fake.stop(); env.cleanup(); }
}, 5000);

test("automation start deadline includes SSH connection and closes a late child", async () => {
  let opened!: (c: RpcClient) => void, closed = false;
  const opening = new Promise<RpcClient>((r) => { opened = r; });
  const runner = createHeadlessRunner({ connectMachine: () => opening });
  const result = await runner({ machine: "fixture", automationId: "fixture", cwd: ".", title: "Fixture", prompt: "Fixture", autonomy: "off", startTimeoutMs: 20, maxRunMs: 1000 });
  expect(result.failureReason).toBe("dispatch_timed_out");
  opened(new RpcClient({ onMessage: () => {}, onClose: () => {}, write() { throw new Error("Timed out startup must not send requests"); }, async close() { closed = true; } }));
  await opening; await new Promise((r) => setTimeout(r, 0));
  expect(closed).toBe(true);
});

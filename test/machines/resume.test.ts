import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import { forkRoutedSession, routedSessionList } from "../../src/machines/resume.ts";
import { RemoteSessionStore } from "../../src/machines/sessions.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";

test("remote CLI list and fork use live SSH transcripts and preserve machine routing", async () => {
  const env = tmpEnv(), remoteHome = join(env.root, "remote-state");
  const fake = await startFakeAnthropic([{ text: "Remote original transcript" }]);
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), script = join(env.root, "fake-ssh-resume.ts");
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  const clients: RpcClient[] = [];
  const connect = async (name: string) => { expect(name).toBe("fixture"); const c = new RpcClient(new SshTransport({ name, host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })); clients.push(c); return c; };
  try {
    const original = await connect("fixture");
    const init = await original.request("initialize_session", { cwd: env.root, title: "Original", modelId: "custom:Remote-fixture-0" });
    await original.request("add_user_message", { text: "Fixture" }); await original.request("settle_session"); await original.close();
    const rows = await routedSessionList(env.root, "fixture", connect);
    expect(rows.map((r) => r.sessionId)).toContain(init.sessionId);
    expect((await routedSessionList(env.root, "local", connect)).map((r) => r.sessionId)).not.toContain(init.sessionId);
    const forked = await forkRoutedSession(init.sessionId, env.root, undefined, connect);
    expect(forked).not.toBe(init.sessionId); expect(new RemoteSessionStore().get(forked)?.machine).toBe("fixture");
    const view = await connect("fixture"), loaded = await view.request("load_session", { sessionId: forked, cwd: env.root });
    expect(JSON.stringify(loaded.session.messages)).toContain("Remote original transcript"); await view.close();
    expect(clients.every((c) => c.isClosed)).toBe(true); expect(fake.requests.length).toBe(1);
  } finally { for (const c of clients) if (!c.isClosed) await c.close(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 5000);

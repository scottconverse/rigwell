import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { DelegationStore } from "../../src/delegation/store.ts";
import { fakeSlack } from "../fakes/fake-slack.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { until } from "../workstreams/helpers.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";

test("durable queued events survive restart, duplicates stay seen and uncertain admitted work is reported without replay", async () => {
  const env = tmpEnv(), slack = fakeSlack(), fake = await startFakeAnthropic([{ text: "Queued work finished" }]), thread = (Date.now() / 1000).toFixed(3);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  try {
    setSecret("app", "fixture-app-token"); setSecret("bot", "fixture-bot-token");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", apiKey: "fixture-key", baseUrl: fake.url }] });
    const store = new DelegationStore(); store.save({ projects: [{ name: "demo", cwd: env.root }], slack: { enabled: true, teamId: "T1", users: ["U1"], appTokenCredential: "app", botTokenCredential: "bot" } });
    const source = { service: "slack" as const, workspace: "T1", user: "U1", conversation: "C1", thread };
    store.enqueue({ id: "slack:T1:queued", at: Date.now(), source, text: "demo: process once" }); store.enqueue({ id: "slack:T1:uncertain", at: Date.now(), source, text: "demo: never automatically repeat" }); store.state("slack:T1:uncertain", "admitted");
    daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, automations: false, sidepane: false, ws: false, delegation: { slackHub: slack.hub } });
    await until(() => slack.posts.some((p) => p.text.includes("Queued work finished")));
    slack.event("queued", "demo: replay", { ts: thread }); await until(() => slack.acks.includes("queued")); expect(fake.requests).toHaveLength(1);
    const status = daemon.delegation!.status(); expect(status.counts).toContainEqual({ state: "uncertain", count: 1 }); expect(status.errors.join(" ")).toContain("not automatically replayed");
  } finally { await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 10_000);

test("configuration requires explicit access confirmation and a failed listener change leaves delegation disabled", async () => {
  const env = tmpEnv(), blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("Occupied"); } });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ socketPath: join(env.root, "d.sock"), backgroundServices: false, automations: false, sidepane: false, ws: false });
    const config = { projects: [{ name: "demo", cwd: env.root }], teams: { enabled: true, tenantId: "11111111-1111-4111-8111-111111111111", appId: "22222222-2222-4222-8222-222222222222", users: ["33333333-3333-4333-8333-333333333333"], secretCredential: "teams", port: blocker.port, publicUrl: "https://tunnel.example/api/delegation/teams" } };
    let denied: unknown; try { await daemon.delegation!.methods.configure_delegation({ config }); } catch (e) { denied = e; } expect(denied).toBeInstanceOf(Error); expect(daemon.delegation!.status().config.projects).toEqual([]);
    let failure: unknown; try { await daemon.delegation!.methods.configure_delegation({ config, confirmed: true }); } catch (e) { failure = e; } expect(failure).toBeInstanceOf(Error);
    expect(daemon.delegation!.status().config.teams?.enabled).toBe(false); expect(new DelegationStore().config().teams?.enabled).toBe(false); expect(daemon.delegation!.status().listener).toBeUndefined();
    await daemon.delegation!.methods.configure_delegation({ confirmed: true, config: { ...config, teams: { ...config.teams, port: 0 } } }); expect(daemon.delegation!.status().listener?.host).toBe("127.0.0.1");
  } finally { await daemon?.stop(); blocker.stop(true); env.cleanup(); }
}, 10_000);

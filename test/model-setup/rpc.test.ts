// The model-setup daemon methods: local catalog, a CLI sign-in that starts, polls and cancels,
// and a connection URL that carries credentials being refused. Fake fetch and fake spawn only.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ErrorCodes } from "../../src/protocol/rpc.ts";
import { discoverLocalServers } from "../../src/model-setup/core/local-discovery.ts";
import { CliSignIn } from "../../src/model-setup/core/cli-signin.ts";
import { createModelSetupMethods } from "../../src/model-setup/rpc.ts";

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Only the LM Studio port answers; the other default ports refuse, as they would on a bare machine. */
const localFetch = (async (url: string) => {
  if (url === "http://127.0.0.1:1234/v1/models") return json({ data: [{ id: "qwen3-8b" }, { id: "granite-3b" }] });
  if (url === "http://127.0.0.1:1234/api/v0/models") return json({ data: [{ id: "qwen3-8b", state: "loaded", type: "llm" }] });
  throw new Error("refused");
}) as any;

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.unref = () => {};
  return child;
}

function methods(options: { signedIn?: () => boolean } = {}) {
  const child = fakeChild();
  const spawns: { command: string; args: string[] }[] = [];
  let clock = 1_000;
  const cli = new CliSignIn({
    probe: async () => ({ signedIn: options.signedIn?.() ?? false }),
    spawnFn: (command, args) => { spawns.push({ command, args }); return child; },
    now: () => clock,
    pollIntervalMs: 0,
    platform: "linux",
    env: { PATH: "/usr/local/bin", HOME: "/home/tester" },
    exists: (candidate) => candidate === "/usr/local/bin/claude",
  });
  const discovered: string[] = [];
  const discoveredOptions: string[] = [];
  const handle = createModelSetupMethods({
    catalog: (force) => discoverLocalServers({ fetchFn: localFetch, includeDefaults: true, now: () => 1 }),
    cli,
    ollamaSignIn: { start: async () => null as any, poll: () => null, cancel: () => null },
    ollamaStatus: async () => ({ running: false, baseUrl: "http://127.0.0.1:11434" }),
    discover: async (connection) => { discoveredOptions.push(connection.baseUrl); return ["from-server"]; },
    test: async () => ({ ok: true, message: "ok", capabilities: { chatCompletions: true, responses: null, modelDiscovery: null }, latencyMs: 1 }),
    secret: (name) => (name === "saved-key" ? "sk-stored" : undefined),
  });
  return { handle, child, spawns, discovered, discoveredOptions, advance: (ms: number) => { clock += ms; } };
}

describe("model_setup_* daemon methods", () => {
  test("catalog returns the servers found on this machine", async () => {
    const { handle } = methods();
    const r = await handle("model_setup_catalog", {});
    expect(r.handled).toBe(true);
    const catalog = (r as { result: any }).result;
    expect(catalog.servers.map((s: any) => [s.kind, s.baseUrl])).toEqual([["lmstudio", "http://127.0.0.1:1234/v1"]]);
    expect(catalog.servers[0].models[0]).toMatchObject({ id: "qwen3-8b", loaded: true });
  });

  test("a Claude sign-in starts, polls while open, then cancels", async () => {
    const { handle, child, spawns } = methods();
    const started = (await handle("model_setup_cli_start", { provider: "claude" }) as { result: any }).result;
    expect(started).toMatchObject({ id: 1, provider: "claude", status: "starting" });
    expect(spawns[0]).toMatchObject({ args: ["auth", "login", "--claudeai"] });

    child.stdout.emit("data", "Opening https://claude.ai/oauth/authorize?code=abc\n");
    const open = (await handle("model_setup_cli_poll", { id: 1 }) as { result: any }).result;
    expect(open).toMatchObject({ status: "awaiting_user", url: "https://claude.ai/oauth/authorize?code=abc" });

    const cancelled = (await handle("model_setup_cli_cancel", { id: 1 }) as { result: any }).result;
    expect(cancelled).toMatchObject({ id: 1, status: "cancelled" });
    expect(child.killed).toBe(true);
  });

  test("a sign-in that completes on the CLI side polls to done", async () => {
    let signedIn = false;
    const { handle } = methods({ signedIn: () => signedIn });
    const started = (await handle("model_setup_cli_start", { provider: "claude" }) as { result: any }).result;
    expect(started.status).toBe("starting");
    signedIn = true;
    const done = (await handle("model_setup_cli_poll", { id: started.id }) as { result: any }).result;
    expect(done.status).toBe("done");
  });

  test("discover refuses a URL that carries credentials", async () => {
    const { handle, discoveredOptions } = methods();
    let failure: any;
    try {
      await handle("model_setup_discover", { baseUrl: "http://user:secret@127.0.0.1:1234/v1" });
    } catch (e) { failure = e; }
    expect(failure?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(String(failure?.message)).toContain("must not include credentials");
    expect(discoveredOptions).toEqual([]);
  });

  test("discover uses a stored secret by name and never returns it", async () => {
    const { handle } = methods();
    const r = await handle("model_setup_discover", { baseUrl: "https://models.example.com/v1", apiKeySecretName: "saved-key" });
    expect(r).toEqual({ handled: true, result: { models: ["from-server"] } });
    const missing = await handle("model_setup_discover", { baseUrl: "https://models.example.com/v1", apiKeySecretName: "absent" }).catch((e) => e);
    expect((missing as any).code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  test("unknown methods are not handled", async () => {
    const { handle } = methods();
    expect(await handle("something_else", {})).toEqual({ handled: false });
  });
});

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorCatalog, mcpSecret } from "../../src/mcp/catalog.ts";
import { McpManager } from "../../src/mcp/manager.ts";
import { McpClient } from "../../src/mcp/client.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeMcpHttp } from "../fakes/fake-mcp-http.ts";

const base = { name: "fixture", description: "Local fake tools", category: "Testing", transport: "http", url: "http://localhost:1/mcp", auth: "none", docs: "https://example.com/docs" };
test("catalog listing is inert, bundled and user JSON are merged, and additions use the displayed snapshot", async () => {
  const env = tmpEnv(); let hits = 0, current: any = { connectors: [base] };
  const server = Bun.serve({ port: 0, fetch() { hits++; return Response.json(current); } });
  try {
    const catalog = new ConnectorCatalog(); expect(hits).toBe(0);
    const source = `http://localhost:${server.port}/catalog.json`;
    const listed = await catalog.list([source, source]); expect(hits).toBe(1); expect(listed.warnings).toEqual([]);
    expect(listed.entries.map((e) => e.name)).toEqual(["linear", "notion", "sentry", "fixture"]);
    const row = listed.entries.at(-1)!; current = { connectors: [{ ...base, url: "http://localhost:2/changed" }] };
    expect(catalog.prepare(row.key)).toMatchObject({ name: "fixture", url: base.url, oauth: false }); expect(hits).toBe(1);
    const file = join(env.root, "catalog.json"); writeJson(file, [base]);
    expect((await catalog.list([file])).entries.at(-1)?.source).toBe(file);
    expect(() => catalog.prepare(row.key)).toThrow("Open the catalog");
  } finally { server.stop(true); env.cleanup(); }
});

test("catalog validates source redirects, bounds and entries without starting an offered command", async () => {
  const env = tmpEnv(); let trapHits = 0;
  const trap = Bun.serve({ port: 0, fetch() { trapHits++; return Response.json([]); } });
  const server = Bun.serve({ port: 0, fetch(req) { return new URL(req.url).pathname === "/large" ? new Response("x".repeat(512 * 1024 + 1)) : Response.redirect(`http://localhost:${trap.port}`, 307); } });
  try {
    const c = new ConnectorCatalog();
    const r = await c.list([`http://localhost:${server.port}/redirect`, `http://localhost:${server.port}/large`, "http://example.com/catalog.json"]);
    expect(r.warnings).toHaveLength(3); expect(r.entries).toHaveLength(3); expect(trapHits).toBe(0);
    const file = join(env.root, "catalog.json");
    for (const invalid of [{ ...base, args: [3] }, { ...base, url: "{{missing}}" }, { ...base, url: "https://example.com/{{token}}", inputs: [{ name: "token", label: "Token", secret: true }] }, { ...base, transport: "stdio", command: "command", auth: "oauth" }]) {
      writeJson(file, [invalid]); expect((await c.list([file])).warnings).toHaveLength(1);
    }
    const marker = join(env.root, "must-not-exist");
    writeJson(file, [{ ...base, transport: "stdio", auth: "none", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] }]);
    expect((await c.list([file])).entries.at(-1)?.transport).toBe("stdio"); expect(existsSync(marker)).toBe(false);
  } finally { server.stop(true); trap.stop(true); env.cleanup(); }
});

test("stdio catalog arguments stay separate and secret environment values resolve only at spawn", async () => {
  const env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()])); let client: McpClient | undefined;
  try {
    const file = join(env.root, "catalog.json");
    writeJson(file, [{ ...base, transport: "stdio", command: process.execPath, args: [join(import.meta.dir, "../fakes/fake-mcp-server.ts"), "{{argument}}"], env: { FAKE_MCP_NAME: "{{secret}}" }, inputs: [{ name: "argument", label: "Argument" }, { name: "secret", label: "Private environment", secret: true }] }]);
    const catalog = new ConnectorCatalog(); const row = (await catalog.list([file])).entries.at(-1)!;
    const cfg = catalog.prepare(row.key, { argument: "one argument ; $(do not execute)", secret: "fixture-private" });
    expect(cfg.args).toHaveLength(2); expect(cfg.args![1]).toBe("one argument ; $(do not execute)"); expect(JSON.stringify(cfg)).not.toContain("fixture-private");
    client = new McpClient({ ...cfg, source: "session" }); await client.connect(); expect(client.serverInfo?.name).toBe("fixture-private");
  } finally { await client?.close(); setCredentialStore(undefined); env.cleanup(); }
});

test("catalog input prompts are enforced, URL values encoded and secret headers stored by reference", async () => {
  const env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()]));
  const fake = startFakeMcpHttp("json", { requireHeader: ["authorization", "Bearer fixture-secret"] });
  const manager = new McpManager({ cwd: env.root });
  try {
    const file = join(env.root, "catalog.json"); writeJson(file, [{ ...base, url: fake.url + "/{{space}}", auth: "token", headers: { authorization: "Bearer {{token}}" }, inputs: [{ name: "space", label: "Workspace" }, { name: "token", label: "API token", secret: true }] }]);
    const { entries } = await manager.listCatalog([file]); const row = entries.at(-1)!;
    const catalog = new ConnectorCatalog(); const displayed = (await catalog.list([file])).entries.at(-1)!;
    expect(() => catalog.prepare(displayed.key)).toThrow("Enter Workspace");
    const cfg = catalog.prepare(displayed.key, { space: "some/path", token: "fixture-secret" });
    expect(cfg.url).toEndWith("some%2Fpath"); expect(cfg.headers!.authorization).toStartWith("keychain:"); expect(mcpSecret(cfg.headers!.authorization!)).toBe("Bearer fixture-secret");
    expect(await manager.addCatalog(row.key, { space: "some/path", token: "fixture-secret" })).toEqual({ name: "fixture", login: undefined });
    expect(manager.listServers().servers[0]).toMatchObject({ status: "connected", toolCount: 4 });
    expect(readFileSync(join(env.rigwellHome, "mcp.json"), "utf8")).not.toContain("fixture-secret");
    let duplicate: unknown; try { await manager.addCatalog(row.key, { space: "another", token: "fixture-secret" }); } catch (e) { duplicate = e; }
    expect(String(duplicate)).toContain("already exists"); expect(manager.listServers().servers).toHaveLength(1);
    expect(fake.seenHeaders[0]?.authorization).toBe("Bearer fixture-secret");
    expect(() => mcpSecret("keychain:missing")).toThrow("credential is missing");
  } finally { await manager.shutdown(); fake.stop(); setCredentialStore(undefined); env.cleanup(); }
});

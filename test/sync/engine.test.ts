import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { makeStubSession, text } from "../agent/helpers.ts";
import { saveSyncConfig } from "../../src/sync/config.ts";
import { configureSync } from "../../src/sync/service.ts";
import { HookRunner, loadHooksConfig } from "../../src/hooks/index.ts";
import { jsCommand } from "../platform.ts";

test("two actual engines cannot continue one synced transcript; closing releases ownership", async () => {
  const env = tmpEnv(), id = crypto.randomUUID();
  saveSyncConfig({ version: 1, folderIsAuthority: true, target: { kind: "folder", path: join(env.root, "target") }, kinds: ["session"], settings: [] });
  const marker = join(env.root, "starts.txt");
  const hooksFor = (ctx: any) => new HookRunner({ ...ctx, cwd: env.root, config: loadHooksConfig({ cwd: env.root, extra: { SessionStart: [{ hooks: [{ type: "command", command: jsCommand(env.root, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n')`) }] }] } }) });
  const a = makeStubSession(() => text("first machine"), { id, hooksFor }), b = makeStubSession(() => text("second machine"), { id, hooksFor });
  try {
    a.session.start(); b.session.start(); expect(existsSync(marker)).toBe(false);
    a.session.addUserMessage("first"); await a.session.settled(); expect(a.requests).toHaveLength(1);
    b.session.addUserMessage("second"); await b.session.settled(); expect(b.requests).toHaveLength(0);
    expect(b.notes.some((n) => n.type === "error" && n.message.includes("owned by"))).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("started\n");
    let blocked: unknown; try { await configureSync(null); } catch (e) { blocked = e; } expect(String(blocked)).toContain("Close synced session engines");
    await a.session.end(); b.session.addUserMessage("after close"); await b.session.settled(); expect(b.requests).toHaveLength(1);
    expect(readFileSync(marker, "utf8")).toBe("started\nstarted\n");
    await b.session.end(); await configureSync(null);
  } finally { await a.session.end(); await b.session.end(); rmSync(a.cwd, { recursive: true, force: true }); rmSync(b.cwd, { recursive: true, force: true }); env.cleanup(); }
});

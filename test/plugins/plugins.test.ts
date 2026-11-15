import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginService } from "../../src/plugins/service.ts";
import { activePlugins, installedPath, pluginRoot, readPluginState, unlinked } from "../../src/plugins/store.ts";
import { SkillRegistry } from "../../src/skills/skills.ts";
import { loadAgents } from "../../src/subagents/agents.ts";
import { loadHooksConfig } from "../../src/hooks/config.ts";
import { runHooks } from "../../src/hooks/runner.ts";
import { loadMcpConfig } from "../../src/mcp/config.ts";
import { McpClient } from "../../src/mcp/client.ts";
import { loadCustomEntries } from "../../src/tui/customcmd.ts";
import { instantiateTemplate, listTemplates } from "../../src/automations/templates.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { pluginFixture } from "./fixture.ts";
import { CLI } from "../e2e/helpers.ts";
import { isPrivate } from "../../src/platform/private.ts";

test("system temporary paths are usable but custom directory aliases and dangling links are rejected", () => {
  const env = tmpEnv();
  try {
    expect(() => unlinked(tmpdir())).not.toThrow();
    expect(() => unlinked(join(env.rigwellHome, "plugins", "not-created"))).not.toThrow();
    if (process.platform === "darwin") {
      expect(() => unlinked("/var/tmp/rigwell-not-created")).not.toThrow();
      expect(() => unlinked("/tmp/rigwell-not-created")).not.toThrow();
    }
    const target = join(env.root, "target"); mkdirSync(target);
    const alias = join(env.root, "var"); symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => unlinked(join(alias, "not-created"))).toThrow("links");
    const dangling = join(env.root, "dangling"); symlinkSync(join(env.root, "absent"), dangling, "file");
    expect(() => unlinked(dangling)).toThrow("links");
  } finally { env.cleanup(); }
});

test("approved snapshots integrate all six contributions, retain precedence, run owned hooks/MCP and disable/uninstall cleanly", async () => {
  const env = tmpEnv(), svc = new PluginService(), source = pluginFixture(join(env.root, "source")), project = join(env.root, "project"); mkdirSync(project);
  let client: McpClient | undefined;
  try {
    expect(svc.methods.list_plugins().indexes).toEqual([]);
    const preview = await svc.preview({ source }); expect(preview.needsTrust).toBe(true); expect(preview.additions.map((a) => a.kind)).toEqual(["skills", "agents", "hooks", "mcp", "commands", "automationTemplates"]);
    expect(isPrivate(pluginRoot())).toBe(true);
    expect(activePlugins()).toHaveLength(0); expect(existsSync(join(project, "plugin-hook.txt"))).toBe(false);
    expect(() => svc.commit(preview.token, false)).toThrow("Confirm");
    const installed = svc.commit(preview.token, true).plugin; expect(activePlugins()).toHaveLength(1);
    expect(new SkillRegistry({ cwd: project, homeDir: env.home }).load().enabled().some((s) => s.name === "fixture-skill")).toBe(true);
    expect(loadAgents({ cwd: project, homeDir: env.home }).agents.some((a) => a.name === "fixture-helper")).toBe(true);
    expect(loadCustomEntries(project, env.home).entries.some((c) => c.name === "fixture-command")).toBe(true);
    expect(instantiateTemplate("fixture-plugin-check").instructions).toContain("Check fixture");
    const hooks = loadHooksConfig({ cwd: project, homeDir: env.home, trustProject: false });
    expect(loadHooksConfig({ cwd: project, allowManagedHooksOnly: true }).events.SessionStart).toBeUndefined();
    const result = await runHooks(hooks, "SessionStart", { session_id: "fixture", transcript_path: "", cwd: project, permission_mode: "auto-high" }, {});
    expect(result.results[0]!.exitCode).toBe(0); expect(readFileSync(join(project, "plugin-hook.txt"), "utf8")).toBe("approved-hook");
    const mcp = loadMcpConfig({ cwd: project, homeDir: env.home, trustProject: false }).servers.find((s) => s.name === "fixture-plugin-fixture")!;
    expect(mcp.env?.RIGWELL_PLUGIN_ROOT).toBe(installedPath(installed));
    client = new McpClient(mcp, { cwd: project }); await client.connect(); expect((await client.listTools())[0]!.name).toBe("echo"); expect((await client.callTool("echo", { text: "hello" })).text).toBe("plugin-echo:hello"); await client.close(); client = undefined;
    mkdirSync(join(env.rigwellHome, "skills/fixture-skill"), { recursive: true }); writeFileSync(join(env.rigwellHome, "skills/fixture-skill/SKILL.md"), '---\nname: fixture-skill\ndescription: Owner override\n---\nOwner instructions.');
    expect(new SkillRegistry({ cwd: project, homeDir: env.home }).load().enabled().find((s) => s.name === "fixture-skill")!.body).toBe("Owner instructions.");
    svc.disable(installed.name); expect(activePlugins()).toHaveLength(0); expect(loadMcpConfig({ cwd: project }).servers).toHaveLength(0); expect(listTemplates().some((t) => t.id === "fixture-plugin-check")).toBe(false);
    const enable = await svc.previewEnable(installed.name); expect(activePlugins()).toHaveLength(0); svc.commit(enable.token, true); expect(activePlugins()).toHaveLength(1); expect(readPluginState().plugins[0]!.source.source).toBe(source);
    expect(() => svc.uninstall(installed.name, false)).toThrow("Confirm"); svc.uninstall(installed.name, true); expect(activePlugins()).toHaveLength(0); expect(existsSync(installedPath(installed))).toBe(false); expect(existsSync(join(source, "hook.cjs"))).toBe(true);
  } finally { await client?.close(); await svc.close(); env.cleanup(); }
});

test("preview is immutable, cancelled or changed assets never load, paths and links are rejected", async () => {
  const env = tmpEnv(), svc = new PluginService(), source = pluginFixture(join(env.root, "source"));
  try {
    const first = await svc.preview({ source }); svc.cancel(first.token); expect(() => svc.commit(first.token, true)).toThrow("unavailable");
    const changed = await svc.preview({ source });
    const staged = readdirSync(join(pluginRoot(), "staging"))[0]!; writeFileSync(join(pluginRoot(), "staging", staged, "snapshot", "hook.cjs"), "changed after preview");
    expect(() => svc.commit(changed.token, true)).toThrow("changed after preview"); expect(activePlugins()).toHaveLength(0);
    const second = await svc.preview({ source }); writeFileSync(join(source, "hook.cjs"), "throw new Error('not approved')"); const installed = svc.commit(second.token, true).plugin;
    expect(readFileSync(join(installedPath(installed), "hook.cjs"), "utf8")).not.toContain("not approved");
    writeFileSync(join(installedPath(installed), "hook.cjs"), "changed"); expect(activePlugins()).toHaveLength(0); expect(svc.methods.list_plugins().plugins[0]!.intact).toBe(false);
    const bad = JSON.parse(readFileSync(join(source, "rigwell-plugin.json"), "utf8")); bad.hooks = "../outside.json"; writeFileSync(join(source, "rigwell-plugin.json"), JSON.stringify(bad));
    const invalid = await svc.preview({ source }, "fixture-plugin").then(() => undefined, (e) => e); expect(invalid.message).toContain("inside");
    delete bad.hooks; writeFileSync(join(source, "rigwell-plugin.json"), JSON.stringify(bad));
    symlinkSync(join(source, "hook.cjs"), join(source, "linked.cjs"));
    const linked = await svc.preview({ source }, "fixture-plugin").then(() => undefined, (e) => e); expect(linked.message).toContain("links");
    const remote = await svc.preview({ source: "https://example.test/plugin.git" }).then(() => undefined, (e) => e); expect(remote.message).toContain("exact commit");
  } finally { await svc.close(); env.cleanup(); }
});

test("pinned local Git and marketplace installs preview exact commits, and updates require fresh approval", async () => {
  const env = tmpEnv(), svc = new PluginService(), source = pluginFixture(join(env.root, "source")), bare = join(env.root, "origin.git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"); const first = git("rev-parse", "HEAD");
    git("clone", "--bare", source, bare);
    const index = join(env.root, "index"); mkdirSync(index); writeFileSync(join(index, "rigwell-marketplace.json"), JSON.stringify({ plugins: [{ name: "fixture-plugin", source: bare, commit: first }] }));
    const indexGit = (...args: string[]) => execFileSync("git", args, { cwd: index, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    indexGit("init", "-q"); indexGit("add", "."); indexGit("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture index"); const indexCommit = indexGit("rev-parse", "HEAD"), indexBare = join(env.root, "index.git"); indexGit("clone", "--bare", index, indexBare);
    await svc.addIndex("fixture-index", { source: indexBare, commit: indexCommit }); expect(activePlugins()).toHaveLength(0); expect(readPluginState().indexes[0]!.source.commit).toBe(indexCommit);
    const preview = await svc.previewIndex("fixture-index", "fixture-plugin"); expect(preview.source.commit).toBe(first); svc.commit(preview.token, true);
    pluginFixture(source, "2.0.0"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "updated fixture"); const second = git("rev-parse", "HEAD"); git("push", bare, "HEAD:refs/heads/updated");
    const update = await svc.preview({ source: bare, commit: second }, "fixture-plugin"); expect(activePlugins()[0]!.manifest.version).toBe("1.0.0"); svc.commit(update.token, true); expect(activePlugins()[0]!.manifest.version).toBe("2.0.0"); expect(readPluginState().plugins[0]!.source.commit).toBe(second);
    svc.removeIndex("fixture-index"); expect(readPluginState().indexes).toEqual([]); expect(activePlugins()).toHaveLength(1);
  } finally { await svc.close(); env.cleanup(); }
});

test("CLI previews before trust, installs only with explicit acceptance, and controls the same registry", async () => {
  const env = tmpEnv(), source = pluginFixture(join(env.root, "source"));
  const run = async (...args: string[]) => { const child = Bun.spawn([process.execPath, CLI, "plugin", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, RIGWELL_HOME: env.rigwellHome } }); const out = await new Response(child.stdout).text(), err = await new Response(child.stderr).text(); return { code: await child.exited, out, err }; };
  try {
    const denied = await run("install", source); expect(denied.code).toBe(2); expect(denied.out).toContain('"needsTrust": true'); expect(readPluginState().plugins).toHaveLength(0);
    expect((await run("install", source, "--yes")).code).toBe(0); expect(activePlugins()).toHaveLength(1);
    expect((await run("disable", "fixture-plugin")).code).toBe(0); expect(activePlugins()).toHaveLength(0);
    expect((await run("enable", "fixture-plugin", "--yes")).code).toBe(0); expect(activePlugins()).toHaveLength(1);
    expect((await run("uninstall", "fixture-plugin")).code).toBe(0); expect(readPluginState().plugins).toHaveLength(0);
  } finally { env.cleanup(); }
}, 15_000);

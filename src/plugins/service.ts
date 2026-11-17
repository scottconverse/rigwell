import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { killProcessTree } from "../platform/shell.ts";
import { parseSkillFile } from "../skills/skills.ts";
import { parseAgentFile } from "../subagents/agents.ts";
import { HOOK_EVENTS, normalizeGroups } from "../hooks/config.ts";
import { normalizeServer } from "../mcp/config.ts";
import { parseSchedule } from "../automations/schedule.ts";
import { COMPONENTS, ensurePluginRoot, inside, installedPath, jsonFile, manifestAt, pluginRoot, readPluginState, savePluginState, snapshotDigest, snapshotFiles, unlinked, validCommit, validName, type Marketplace, type PluginRecord, type PluginSource } from "./store.ts";

function copySnapshot(source: string, target: string) {
  const files = snapshotFiles(source); unlinked(target); mkdirSync(target, { recursive: true });
  for (const f of files) { const out = inside(target, f.path); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, f.data, { mode: f.mode }); chmodSync(out, f.mode); }
}
const removeOwned = (path: string) => { inside(pluginRoot(), path); unlinked(path); rmSync(path, { recursive: true, force: true }); };
function git(args: string[], cwd: string | undefined, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveDone, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=" + join(pluginRoot(), "empty-hooks"), "-c", "protocol.ext.allow=never", "-c", "core.askPass=", ...args], { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
    let output = "", error = "", timedOut = false;
    child.stdout.on("data", (b) => { if (output.length < 8192) output += b; }); child.stderr.on("data", (b) => { if (error.length < 8192) error += b; });
    const stop = () => { if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 60_000); signal.addEventListener("abort", stop, { once: true });
    child.once("error", (e) => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(e); }); child.once("close", (code) => { clearTimeout(timer); signal.removeEventListener("abort", stop); code === 0 && !timedOut && !signal.aborted ? resolveDone(output.trim()) : reject(new Error(signal.aborted ? "Plugin operation cancelled" : timedOut ? "Plugin Git operation timed out" : `Plugin Git operation failed: ${error.slice(-1500)}`)); });
  });
}
export function checkedSource(raw: unknown): PluginSource {
  const s = raw as PluginSource;
  if (!s || typeof s.source !== "string" || !s.source.trim() || /[\0\r\n]/.test(s.source)) throw new Error("Choose a plugin source");
  if (Object.keys(s).some((k) => !["source", "commit", "subdir"].includes(k))) throw new Error("Unknown plugin source field");
  if (s.commit !== undefined && !validCommit(s.commit)) throw new Error("Pin Git sources to a full lowercase commit SHA");
  if (!existsSync(s.source)) {
    let u: URL; try { u = new URL(s.source); } catch { throw new Error("Use an existing local folder or HTTPS/SSH Git URL"); }
    if (!["https:", "ssh:"].includes(u.protocol) || u.password || (u.protocol === "https:" && u.username) || u.search || u.hash || !s.commit) throw new Error("Git sources need HTTPS/SSH, no embedded credentials, and an exact commit");
  }
  if (s.subdir !== undefined && (typeof s.subdir !== "string" || !s.subdir || /[\0\r\n]/.test(s.subdir))) throw new Error("Invalid source subfolder");
  return { ...s, source: existsSync(s.source) ? resolve(s.source) : s.source };
}
async function stageSource(raw: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = checkedSource(raw), dir = inside(ensurePluginRoot(), `staging/${randomUUID()}`); mkdirSync(dir, { recursive: true });
  try {
    let root = source.source;
    if (source.commit) {
      const checkout = join(dir, "checkout"); mkdirSync(checkout); await git(["init", "--quiet"], checkout, signal);
      await git(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.source, source.commit], checkout, signal);
      const sha = await git(["rev-parse", "--verify", `${source.commit}^{commit}`], checkout, signal); if (sha !== source.commit) throw new Error("Git source did not resolve to the pinned commit");
      await git(["checkout", "--detach", source.commit, "--"], checkout, signal); root = checkout;
    }
    if (source.subdir) root = inside(root, source.subdir);
    const snapshot = join(dir, "snapshot"); copySnapshot(root, snapshot);
    return { source, dir, snapshot };
  } catch (e) { removeOwned(dir); throw e; }
}
/** Validate actual assets, not just manifest claims, and expose all additions before trust. */
export function inspectPlugin(root: string) {
  const manifest = manifestAt(root), additions: { kind: string; name: string; detail: unknown }[] = [];
  for (const kind of COMPONENTS) {
    const rel = manifest[kind]; if (!rel) continue; const path = inside(root, rel);
    if (["skills", "agents", "commands"].includes(kind)) {
      for (const name of readdirSync(path).sort()) {
        const file = kind === "skills" ? join(path, name, "SKILL.md") : join(path, name);
        if (kind !== "skills" && !name.endsWith(".md")) continue;
        const raw = readFileSync(file, "utf8");
        if (kind === "skills") { const skill = parseSkillFile(file, raw, "user-dir"); if (skill.errors.length) throw new Error(`Invalid skill ${name}: ${skill.errors.join("; ")}`); additions.push({ kind, name: skill.name, detail: skill.description }); }
        else if (kind === "agents") { const agent = parseAgentFile(file, raw, "personal"); if (!agent) throw new Error(`Invalid agent ${name}`); additions.push({ kind, name: agent.name, detail: { description: agent.description, tools: agent.tools, mcpServers: agent.mcpServers } }); }
        else { if (!raw.trim()) throw new Error(`Empty command ${name}`); additions.push({ kind, name: name.slice(0, -3), detail: raw }); }
      }
    } else if (kind === "hooks") {
      const raw = jsonFile(path), hooks = raw.hooks ?? raw;
      for (const [event, groups] of Object.entries(hooks)) {
        if (!HOOK_EVENTS.includes(event as any) || !Array.isArray(groups)) throw new Error("Invalid plugin hook event");
        const normalized = normalizeGroups(groups); if (!normalized.length || normalized.length !== groups.length || normalized.some((g, i) => g.hooks.length !== (groups[i] as any).hooks?.length)) throw new Error("Invalid plugin hook command");
        additions.push({ kind, name: event, detail: normalized });
      }
    } else if (kind === "mcp") {
      const raw = jsonFile(path), servers = raw.mcpServers ?? raw;
      for (const [name, value] of Object.entries(servers)) { const server = normalizeServer(name, value, "user"); if (!server) throw new Error(`Invalid MCP server ${name}`); additions.push({ kind, name, detail: { type: server.type, command: server.command, args: server.args, url: server.url, environmentNames: Object.keys(server.env ?? {}), headerNames: Object.keys(server.headers ?? {}), oauth: !!server.oauth } }); }
    } else {
      const templates = jsonFile(path); if (!Array.isArray(templates) || templates.length > 50) throw new Error("Templates must be an array of at most fifty entries");
      for (const t of templates) {
        if (!validName(t.id) || !["name", "description", "instructions"].every((k) => typeof t[k] === "string") || !Array.isArray(t.parameters) || !["off", "low", "medium", "high"].includes(t.autonomy) || !["health", "dependencies", "testing", "release", "git"].includes(t.category)) throw new Error("Invalid automation template");
        parseSchedule(t.schedule);
        const keys = t.parameters.map((p: any) => p.key); if (new Set(keys).size !== keys.length || t.parameters.some((p: any) => !/^[a-zA-Z][\w]*$/.test(p.key) || typeof p.label !== "string" || typeof p.description !== "string" || (p.default !== undefined && typeof p.default !== "string")) || [...t.instructions.matchAll(/\{\{(\w+)\}\}/g)].some((m: RegExpMatchArray) => !keys.includes(m[1]))) throw new Error("Invalid template parameters");
        additions.push({ kind, name: `${manifest.name}-${t.id}`, detail: t });
      }
    }
  }
  if (!additions.length) throw new Error("Plugin contains no usable contributions");
  return { manifest, additions, needsTrust: additions.some((a) => a.kind === "hooks" || a.kind === "mcp") };
}

export class PluginService {
  private controller = new AbortController();
  private staging = new Set<Promise<Awaited<ReturnType<typeof stageSource>>>>();
  private stage(raw: unknown) { const task = stageSource(raw, this.controller.signal); this.staging.add(task); void task.finally(() => this.staging.delete(task)).catch(() => {}); return task; }
  private previews = new Map<string, { staged: Awaited<ReturnType<typeof stageSource>>; digest: string; expires: number; updating?: string }>();
  async preview(source: unknown, updating?: string) {
    if (updating && !readPluginState().plugins.some((p) => p.name === updating)) throw new Error("Unknown installed plugin");
    if (this.previews.size >= 10) throw new Error("Cancel an outstanding plugin preview first");
    const staged = await this.stage(source);
    try {
      const inspection = inspectPlugin(staged.snapshot), digest = snapshotDigest(staged.snapshot);
      if (updating && updating !== inspection.manifest.name) throw new Error("Updates must preserve plugin identity");
      if (!updating && readPluginState().plugins.some((p) => p.name === inspection.manifest.name)) throw new Error("Plugin already installed; preview an update");
      const token = randomUUID(); this.previews.set(token, { staged, digest, expires: Date.now() + 15 * 60_000, updating });
      return { token, source: staged.source, digest, ...inspection };
    } catch (e) { removeOwned(staged.dir); throw e; }
  }
  cancel(token: string) { const p = this.previews.get(token); if (p) { removeOwned(p.staged.dir); this.previews.delete(token); } return { cancelled: true }; }
  commit(token: string, confirmed: boolean) {
    if (!confirmed) throw new Error("Confirm the plugin additions, hooks and MCP trust before installation");
    const p = this.previews.get(token); if (!p || p.expires < Date.now()) { if (p) this.cancel(token); throw new Error("Plugin preview expired or unavailable"); }
    if (snapshotDigest(p.staged.snapshot) !== p.digest) { this.cancel(token); throw new Error("Plugin changed after preview"); }
    const { manifest } = inspectPlugin(p.staged.snapshot), state = readPluginState(), old = state.plugins.find((v) => v.name === manifest.name);
    if ((p.updating && !old) || (!p.updating && old) || (!old && state.plugins.length >= 100)) throw new Error("Installed plugins changed; preview again");
    const record: PluginRecord = { name: manifest.name, manifest, digest: p.digest, source: p.staged.source, enabled: true, installedAt: Date.now() }, target = installedPath(record);
    if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); renameSync(p.staged.snapshot, target); }
    else if (snapshotDigest(target) !== p.digest) throw new Error("Installed snapshot has been modified");
    state.plugins = [...state.plugins.filter((v) => v.name !== record.name), record]; savePluginState(state); this.cancel(token);
    return { plugin: record, note: "Changes apply to new sessions; existing sessions retain their loaded tools." };
  }
  disable(name: string) { const state = readPluginState(), p = state.plugins.find((p) => p.name === name); if (!p) throw new Error("Unknown plugin"); p.enabled = false; savePluginState(state); return { plugin: p }; }
  async previewEnable(name: string) { const p = readPluginState().plugins.find((p) => p.name === name); if (!p) throw new Error("Unknown plugin"); const preview = await this.preview({ source: installedPath(p) }, name); this.previews.get(preview.token)!.staged.source = p.source; return { ...preview, source: p.source }; }
  uninstall(name: string, confirmed: boolean) {
    if (!confirmed) throw new Error("Confirm plugin removal");
    const state = readPluginState(), p = state.plugins.find((v) => v.name === name); if (!p) throw new Error("Unknown plugin");
    p.enabled = false; savePluginState(state);
    removeOwned(inside(pluginRoot(), `installed/${name}`)); state.plugins = state.plugins.filter((v) => v.name !== name); savePluginState(state); return { removed: name };
  }
  async addIndex(name: string, source: unknown, file = "rigwell-marketplace.json") {
    if (!validName(name)) throw new Error("Invalid marketplace name");
    const staged = await this.stage(source);
    try {
      const data = jsonFile(inside(staged.snapshot, file)); if (!data || !Array.isArray(data.plugins) || data.plugins.length > 100) throw new Error("Marketplace needs a plugins array of at most one hundred entries");
      const names = new Set<string>();
      const plugins: Marketplace["plugins"] = data.plugins.map((p: any) => { if (!validName(p.name) || names.has(p.name) || !validCommit(p.commit)) throw new Error("Marketplace plugins need unique names and exact Git commits"); names.add(p.name); const source = checkedSource({ source: p.source, commit: p.commit, ...(p.subdir ? { subdir: p.subdir } : {}) }); return { name: p.name, source: source.source, commit: p.commit, ...(p.subdir ? { subdir: p.subdir } : {}), ...(typeof p.description === "string" ? { description: p.description.slice(0, 2000) } : {}) }; });
      const index: Marketplace = { name, source: staged.source, plugins };
      const state = readPluginState(); if (!state.indexes.some((i) => i.name === name) && state.indexes.length >= 30) throw new Error("Marketplace limit reached");
      state.indexes = [...state.indexes.filter((i) => i.name !== name), index]; savePluginState(state); return { index };
    } finally { removeOwned(staged.dir); }
  }
  removeIndex(name: string) { const state = readPluginState(); state.indexes = state.indexes.filter((i) => i.name !== name); savePluginState(state); return { removed: name }; }
  async previewIndex(index: string, name: string) { const item = readPluginState().indexes.find((i) => i.name === index)?.plugins.find((p) => p.name === name); if (!item) throw new Error("Unknown marketplace entry"); const preview = await this.preview({ source: item.source, commit: item.commit, ...(item.subdir ? { subdir: item.subdir } : {}) }); if (preview.manifest.name !== name) { this.cancel(preview.token); throw new Error("Marketplace entry differs from plugin identity"); } return preview; }
  async close() { this.controller.abort(); await Promise.allSettled([...this.staging]); for (const token of this.previews.keys()) this.cancel(token); }
  methods = {
    list_plugins: () => { const state = readPluginState(); return { ...state, plugins: state.plugins.map((p) => ({ ...p, intact: (() => { try { return snapshotDigest(installedPath(p)) === p.digest; } catch { return false; } })() })) }; },
    preview_plugin: (p: any) => this.preview(p.source, p.updating), commit_plugin: (p: any) => this.commit(String(p.token), p.confirmed === true), cancel_plugin_preview: (p: any) => this.cancel(String(p.token)),
    disable_plugin: (p: any) => this.disable(String(p.name)), enable_plugin_preview: (p: any) => this.previewEnable(String(p.name)), uninstall_plugin: (p: any) => this.uninstall(String(p.name), p.confirmed === true),
    add_plugin_index: (p: any) => this.addIndex(String(p.name), p.source, p.file), remove_plugin_index: (p: any) => this.removeIndex(String(p.name)), preview_index_plugin: (p: any) => this.previewIndex(String(p.index), String(p.name)),
  };
}

// Content of the config overlays: /mcp /hooks /skills /commands /agents /diagnostics /statusline /automations.
// Reads configuration in-process (the TUI runs on the same machine as the files) and uses protocol requests for live
// state (MCP servers, automations). No terminal I/O.
import { loadHooksConfig, HOOK_EVENTS } from "../hooks/index.ts";
import { SkillRegistry } from "../skills/index.ts";
import { loadAgents } from "../subagents/index.ts";
import { loadSettings } from "../storage/settings.ts";
import { loadCustomCommands } from "./customcmd.ts";
import { runStatusLine, statusLineConfig, type StatusLineInput } from "./attention.ts";
import type { TuiState } from "./types.ts";

export interface ViewCtx {
  request: (method: string, params: Record<string, unknown>) => Promise<any>;
  state: TuiState;
  connection: string;
  settingsPath?: string;
}
export interface View { title: string; lines: string[] }

const errText = (e: unknown) => String((e as Error)?.message ?? e);
const hr = (n: string, v: unknown) => `${n.padEnd(14)} ${v}`;

/** Splits a command line into words, honouring single and double quotes. */
export function words(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export function statusLineInput(s: TuiState): StatusLineInput {
  return {
    session_id: s.sessionId, cwd: s.cwd, version: s.version,
    model: { id: s.modelId, display_name: s.models.find((m) => m.id === s.modelId)?.displayName ?? s.modelId },
    mode: s.mode, autonomy: s.autonomy, reasoning: s.reasoning, running: s.running,
    context: { used_tokens: s.contextUsed, limit_tokens: s.contextLimit, used_percent: s.contextLimit ? Math.round((s.contextUsed / s.contextLimit) * 1000) / 10 : null },
  };
}

// ---------------------------------------------------------------- /mcp

async function mcpView(args: string, c: ViewCtx): Promise<View> {
  const w = words(args);
  const title = "MCP servers";
  try {
    if (w[0] === "add") {
      const [, name, target, ...rest] = w;
      if (!name || !target) return { title, lines: ["Usage: /mcp add <name> <url | command> [args...]", "  An http(s) URL adds a remote server (add --sse before the URL for SSE); anything else is a stdio command."] };
      const sse = target === "--sse";
      const first = sse ? rest[0] : target;
      const tail = sse ? rest.slice(1) : rest;
      const params = /^https?:\/\//.test(first ?? "")
        ? { name, type: sse ? "sse" : "http", url: first }
        : { name, type: "stdio", command: first, args: tail };
      await c.request("add_mcp_server", params);
      return { title, lines: [`Added "${name}" to the user MCP config and started it.`, "", ...(await mcpLines(c))] };
    }
    if (w[0] === "remove") {
      if (!w[1]) return { title, lines: ["Usage: /mcp remove <name>"] };
      const r = await c.request("remove_mcp_server", { serverName: w[1], settingsLevel: "user" });
      return { title, lines: [r?.success ? `Removed "${w[1]}".` : `No user-level server named "${w[1]}".`, "", ...(await mcpLines(c))] };
    }
    return { title, lines: await mcpLines(c) };
  } catch (e) {
    return { title, lines: [`MCP: ${errText(e)}`] };
  }
}

async function mcpLines(c: ViewCtx): Promise<string[]> {
  const r = await c.request("list_mcp_servers", {});
  const servers: any[] = r?.servers ?? [];
  const out: string[] = [];
  if (!servers.length) out.push("No MCP servers are configured.");
  for (const s of servers) {
    out.push(`${s.name}  [${s.status}]  ${s.serverType}  from ${s.source}${s.toolCount !== undefined ? `  ${s.toolCount} tools` : ""}`);
    if (s.error) out.push(`    error: ${s.error}`);
  }
  if (r?.summary?.configError) out.push("", `Config problem: ${r.summary.configError}`);
  out.push("", "/mcp add <name> <url | command> [args...]   /mcp remove <name>", "Servers are stored in the user MCP config (add and remove act on the user level only).");
  return out;
}

// ---------------------------------------------------------------- read-only config views

function hooksView(c: ViewCtx): View {
  const cfg = loadHooksConfig({ cwd: c.state.cwd });
  const lines: string[] = [`Hooks are ${cfg.hooksDisabled ? "turned OFF (hooksDisabled)" : "on"}. Hook output is ${cfg.showHookOutput ? "shown" : "hidden"}.`, ""];
  let n = 0;
  for (const ev of HOOK_EVENTS) {
    const groups = cfg.events[ev] ?? [];
    if (!groups.length) continue;
    lines.push(ev);
    for (const g of groups) for (const h of g.hooks) {
      n++;
      lines.push(`  ${g.matcher ? `[${g.matcher}] ` : ""}${h.command}  (${h.timeout ?? 60}s${g.level ? ", " + g.level : ""})${g.level === "org" ? "  [managed by org]" : ""}`);
    }
  }
  if (!n) lines.push("No hooks are configured.");
  if (cfg.warnings.length) lines.push("", "Problems:", ...cfg.warnings.map((x) => "  " + x));
  lines.push("", "Edit the `hooks` key in settings.json, or hooks.json, in ~/.rigwell or <project>/.rigwell. This view is read-only.");
  return { title: "Hooks", lines };
}

function skillsView(c: ViewCtx): View {
  const reg = new SkillRegistry({ cwd: c.state.cwd }).load();
  const lines: string[] = [];
  for (const s of reg.all) {
    lines.push(`${s.name || "(no name)"}  [${s.status}]  ${s.bucket}${s.userInvocable ? "" : "  (not user-invocable)"}`);
    if (s.description) lines.push(`    ${s.description.slice(0, 120)}`);
    for (const e of s.errors) lines.push(`    ${e}`);
  }
  if (!lines.length) lines.push("No skills found.");
  lines.push("", "Skills live in <project>/.rigwell/skills/<name>/SKILL.md and ~/.rigwell/skills/<name>/SKILL.md. Run one with /<name> [args].", "Turn one off with `disabledSkills` in settings.json.");
  return { title: "Skills", lines };
}

function commandsView(c: ViewCtx): View {
  const cmds = loadCustomCommands(c.state.cwd);
  const lines: string[] = cmds.length ? cmds.map((x) => `/${x.name}${x.argHint ? " " + x.argHint : ""}  (${x.origin})  ${x.desc}\n    ${x.filePath}`) : ["No custom commands found."];
  lines.push("", "A custom command is a Markdown file: <project>/.rigwell/commands/<name>.md or ~/.rigwell/commands/<name>.md.",
    "The body is the prompt. $ARGUMENTS is replaced with what you type after the command; $1..$9 with single words.",
    "Optional frontmatter: description, argument-hint. Restart the session (/new) to pick up changes.");
  return { title: "Custom commands", lines };
}

function agentsView(c: ViewCtx): View {
  const { agents, shadowed } = loadAgents({ cwd: c.state.cwd });
  const lines: string[] = [];
  for (const a of agents) lines.push(`${a.name}  (${a.location}, model ${a.model}${a.tools ? ", tools " + a.tools.join(" ") : ""})\n    ${a.description || "(no description)"}`);
  for (const a of shadowed) lines.push(`${a.name}  (${a.location}, shadowed by an earlier agent of the same name)`);
  if (!lines.length) lines.push("No custom subagents found.");
  lines.push("", "Subagents are Markdown files: <project>/.rigwell/agents/<name>.md and ~/.rigwell/agents/<name>.md. The Task tool launches them.");
  return { title: "Custom subagents", lines };
}

// ---------------------------------------------------------------- /diagnostics

async function diagnosticsView(c: ViewCtx): Promise<View> {
  const s = c.state;
  const loaded = loadSettings({ cwd: s.cwd, runtimeSettingsPath: c.settingsPath });
  const lines: string[] = [
    "Versions", hr("  Rigwell", s.version), hr("  Bun", Bun.version), hr("  Platform", `${process.platform} ${process.arch}`), "",
    "Connection", hr("  Transport", c.connection), hr("  Session", s.sessionId ?? "(none)"), hr("  Folder", s.cwd), hr("  Data folder", s.homeDir), "",
    "Model", hr("  Model", `${s.models.find((m) => m.id === s.modelId)?.displayName ?? s.modelId} (${s.modelId})`), hr("  Reasoning", s.reasoning),
    hr("  Mode", `${s.mode} / autonomy ${s.autonomy}`), hr("  Context", s.contextLimit ? `${s.contextUsed}/${s.contextLimit} tokens` : "not available yet"), "",
  ];
  let issues = 0;
  lines.push("MCP");
  try {
    const r = await c.request("list_mcp_servers", {});
    const sm = r?.summary ?? {};
    lines.push(`  ${sm.total ?? 0} servers: ${sm.connected ?? 0} connected, ${sm.connecting ?? 0} connecting, ${sm.failed ?? 0} failed, ${sm.disabled ?? 0} disabled`);
    for (const x of r?.servers ?? []) if (x.status === "failed") { issues++; lines.push(`  ${x.name}: ${x.error ?? "failed"}`); }
    if (sm.configError) { issues++; lines.push(`  config: ${sm.configError}`); }
  } catch (e) { lines.push(`  not available: ${errText(e)}`); }
  lines.push("", "Settings sources (highest priority first)");
  for (const src of loaded.sources) lines.push(`  ${src.level.padEnd(8)} ${src.path || "(built in)"}${src.level === "org" ? "  [managed by org]" : ""}`);
  const problems: string[] = [...loaded.warnings];
  const hooks = loadHooksConfig({ cwd: s.cwd });
  problems.push(...hooks.warnings);
  for (const k of new SkillRegistry({ cwd: s.cwd }).load().all) if (k.status === "invalid") problems.push(`skill ${k.filePath}: ${k.errors.join("; ")}`);
  issues += problems.length;
  lines.push("", problems.length ? "Config problems" : "Config problems: none", ...problems.map((p) => "  " + p));
  lines.push("", `Logs: warnings go to the process log (stderr). ${issues} issue${issues === 1 ? "" : "s"} found.`);
  return { title: "Diagnostics", lines };
}

// ---------------------------------------------------------------- /statusline

function statusLineView(c: ViewCtx): View {
  const loaded = loadSettings({ cwd: c.state.cwd, runtimeSettingsPath: c.settingsPath });
  const cfg = statusLineConfig(loaded.settings);
  const lines: string[] = [];
  if (!cfg) {
    lines.push("No custom status line is configured.", "", 'Add to settings.json: "statusLine": { "type": "command", "command": "<your command>", "padding": 0, "maxRows": 1 }');
  } else {
    lines.push(`Command: ${cfg.command}`, `Rows: ${cfg.maxRows}   Padding: ${cfg.padding}`, "");
    const r = runStatusLine(cfg, statusLineInput(c.state), c.state.cwd);
    lines.push(r.ok ? "Output now:" : "Problem:", ...(r.ok ? (r.text ? r.text.split("\n").map((l) => "  " + l) : ["  (empty)"]) : ["  " + r.hint]));
  }
  lines.push("", "The command runs through the shell, gets this JSON on stdin and must finish within 2 seconds:",
    '  {"session_id","cwd","version","model":{"id","display_name"},"mode","autonomy","reasoning","running",',
    '   "context":{"used_tokens","limit_tokens","used_percent"}}',
    "Its first maxRows lines are shown above the status bar. It refreshes after each turn and about every 5 seconds while idle.");
  return { title: "Status line", lines };
}

// ---------------------------------------------------------------- /automations

async function automationsView(args: string, c: ViewCtx): Promise<View> {
  const title = "Automations";
  const w = words(args);
  try {
    const list = async () => ((await c.request("list_automations", {}))?.automations ?? []) as any[];
    const find = async (key: string) => {
      const all = await list();
      return all.find((a) => a.id === key || a.name === key || a.id.startsWith(key));
    };
    if (w[0] && ["pause", "resume", "run", "delete"].includes(w[0])) {
      const a = w[1] ? await find(w[1]) : undefined;
      if (!a) return { title, lines: [w[1] ? `No automation matches "${w[1]}".` : `Usage: /automations ${w[0]} <id|name>`] };
      const r = await c.request(`${w[0]}_automation`, { id: a.id });
      const msg = w[0] === "run" ? `Started a run of "${a.name}" (${r?.runId ?? ""}).` : `${w[0] === "delete" ? "Deleted" : w[0] === "pause" ? "Paused" : "Resumed"} "${a.name}".`;
      return { title, lines: [msg] };
    }
    if (w[0] === "history") {
      const a = w[1] ? await find(w[1]) : undefined;
      if (!a) return { title, lines: ["Usage: /automations history <id|name>"] };
      const h = await c.request("get_automation_history", { id: a.id });
      const runs: any[] = h?.runs ?? [];
      return { title: `${title}: ${a.name}`, lines: runs.length ? runs.slice(-15).map((r) => `${r.startedAt ?? r.at ?? ""}  ${r.status ?? ""}  ${r.sessionId ?? ""}`) : ["No runs yet."] };
    }
    const all = await list();
    const lines: string[] = all.length ? [] : ["No automations. Create one from the desktop app or with the CreateAutomation tool."];
    for (const a of all) {
      lines.push(`${a.name}  [${a.status}]  ${a.trigger === "webhook" ? "webhook" : a.schedule ?? ""}  id ${a.id}`);
      lines.push(`    last run ${a.lastRunAt ?? "never"}${a.lastRunStatus ? " (" + a.lastRunStatus + ")" : ""}   next ${a.nextRunAt ?? "-"}   runs ${a.runCount ?? 0}`);
      if (a.error || a.invalidReason) lines.push(`    ${a.error ?? a.invalidReason}`);
    }
    lines.push("", "/automations pause|resume|run|delete <id|name>   /automations history <id|name>");
    return { title, lines };
  } catch (e) {
    return { title, lines: [/not found|unknown method/i.test(errText(e)) ? "Automations need the daemon: start it with `rigwell daemon` and run the TUI with --daemon." : `Automations: ${errText(e)}`] };
  }
}

export async function buildView(name: string, args: string, c: ViewCtx): Promise<View> {
  switch (name) {
    case "mcp": return mcpView(args, c);
    case "hooks": return hooksView(c);
    case "skills": return skillsView(c);
    case "commands": return commandsView(c);
    case "agents": return agentsView(c);
    case "diagnostics": return diagnosticsView(c);
    case "statusline": return statusLineView(c);
    default: return automationsView(args, c);
  }
}

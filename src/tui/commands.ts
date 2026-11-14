// Slash commands kept for v1 (spec §13.2, "v1" column = check mark).
// The custom subagents command is `/agents` here (the spec table's name is not used in Rigwell).

import type { CustomEntry } from "./types.ts";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  desc: string;
  args?: string;
  /** Asks "stop the current run?" first when the agent is running (spec §13.2). */
  stopsRun?: boolean;
  /** Set for custom commands and skills listed after the built-in ones. */
  custom?: CustomEntry;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", desc: "Keys, modes and autonomy levels" },
  { name: "new", aliases: ["clear"], desc: "Start a new session", stopsRun: true },
  { name: "sessions", aliases: ["resume"], desc: "List recent sessions or resume one by id", args: "[id]", stopsRun: true },
  { name: "model", desc: "Pick the model" },
  { name: "settings", desc: "Show session settings" },
  { name: "context", desc: "Context usage by category" },
  { name: "cost", desc: "Token usage and cost" },
  { name: "status", desc: "Version, mode, session, folder, model, data folder" },
  { name: "pr", desc: "PR status or create a PR after approval", args: '[create "title" ["body"] [base] [--draft]]' },
  { name: "review", desc: "Branch or PR summary and semantic changes", args: "[base | pr [number]]" },
  { name: "workstreams", aliases: ["ws"], desc: "Workstreams roster and messages", args: '[id | send <agent> <text> | interrupt <agent>]' },
  { name: "missions", desc: "Pick a mission session", stopsRun: true },
  { name: "compress", desc: "Summarise into a new session", args: "[instructions]", stopsRun: true },
  { name: "rewind-conversation", desc: "Go back to an earlier user turn", stopsRun: true },
  { name: "fork", desc: "Copy this session into a new one" },
  { name: "rename", desc: "Rename the session", args: "<title>" },
  { name: "btw", desc: "Ask a side question without interrupting the agent", args: "<question>" },
  { name: "copy", desc: "Copy the last assistant message" },
  { name: "cwd", aliases: ["cd"], desc: "Change the working folder", args: "<dir>", stopsRun: true },
  { name: "mcp", desc: "MCP servers", args: "[add <name> <url|cmd> | remove <name> | sign-in <name> | sign-out <name>]" },
  { name: "hooks", desc: "Manage hooks" },
  { name: "skills", desc: "Skills settings" },
  { name: "commands", desc: "Manage custom slash commands" },
  { name: "agents", desc: "Manage custom subagents" },
  { name: "statusline", desc: "Show and test the custom status line" },
  { name: "vim", desc: "Toggle vim keys in the input" },
  { name: "themes", desc: "Colour theme (dark or light)", args: "[dark|light]" },
  { name: "automations", desc: "Scheduled automations", args: "[pause|resume|run|delete|history <id>]" },
  { name: "loop", desc: "Repeat a prompt on an interval", args: "<30m|2h> <prompt> | list | stop [id|all]" },
  { name: "diagnostics", desc: "Versions, connection, MCP and config problems" },
  { name: "login", desc: "Sign in to an OAuth account provider", args: "[provider] [--device]" },
  { name: "logout", desc: "Sign out of an OAuth account provider", args: "[provider]" },
  { name: "quit", aliases: ["exit"], desc: "Quit" },
];

export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

export const customAsCommand = (e: CustomEntry): SlashCommand => ({
  name: e.name, desc: `${e.desc}${e.kind === "skill" ? " (skill)" : ""}`, args: e.argHint, custom: e,
});

/** Commands matching the text typed after "/" (prefix match on name or alias; all when empty). */
export function matchCommands(prefix: string, custom: CustomEntry[] = []): SlashCommand[] {
  const p = prefix.toLowerCase();
  return [...COMMANDS, ...custom.map(customAsCommand)].filter((c) => c.name.startsWith(p) || c.aliases?.some((a) => a.startsWith(p)));
}

export const KEY_HELP: [string, string][] = [
  ["Enter", "Send; while running, steer (delivered after the next tool call)"],
  ["Ctrl+Enter", "Queue (sent when the agent finishes); Alt+Enter where Ctrl+Enter is not reported"],
  ["\\ + Enter", "New line"],
  ["Esc", "Cancel the run; leave Bash mode; close a panel or menu"],
  ["Double Esc / Ctrl+C", "Clear the input (Ctrl+C on empty input twice quits)"],
  ["Double Esc on empty input", "Rewind to an earlier message"],
  ["Up / Down", "Input history, or move between lines"],
  ["PageUp / PageDown, Alt+PgUp/PgDn", "Scroll the transcript one page"],
  ["Alt+Up / Alt+Down", "Scroll the transcript one user turn"],
  ["@", "File path picker"],
  ["/", "Command menu (Up/Down, Tab or Enter, Esc)"],
  ["!", "Bash mode: run a shell command directly (on empty input)"],
  ["Shift+Tab", "Cycle the interaction mode (auto and spec)"],
  ["Ctrl+L", "Cycle the autonomy level"],
  ["Tab", "Cycle the reasoning level"],
  ["Ctrl+N", "Cycle models"],
  ["Ctrl+O", "Toggle detailed view (tool output and diffs)"],
  ["Ctrl+P", "Edit the input in $EDITOR"],
  ["Alt+X", "Toggle auto-compress"],
  ["Ctrl+R / Ctrl+G / Ctrl+X", "Review / pull the top / clear queued messages"],
  ["?", "Show or hide this help (on empty input)"],
];

export const AUTONOMY_HELP: [string, string][] = [
  ["off", "every action needs approval"],
  ["low", "file edits and read-only commands run on their own"],
  ["medium", "reversible commands run on their own too"],
  ["high", "all commands run on their own"],
];

/** Status-bar text per autonomy level (spec §13.1). */
export const AUTONOMY_STATUS: Record<string, string> = {
  off: "Off · every action asks",
  low: "Auto (Low) · allow file edits",
  medium: "Auto (Med) · allow reversible commands",
  high: "Auto (High) · allow all commands",
};

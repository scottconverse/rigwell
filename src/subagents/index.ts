// Custom subagents and the Task tool core (spec §5.9, §12.2 "Custom subagents"). Standalone; the lead wires it in.
//
// Folder naming: personal `$RIGWELL_HOME/agents/<name>.md`, project `<root>/.rigwell/agents/<name>.md`.
//
// Integration:
//   - Session start: `const { agents } = loadAgents({cwd, isValidModel})`; `agentCatalog(agents)` gives `name: description`
//     lines to append to the Task tool description when the session lists any (prompts.md §5.14 "agent: the name of a custom agent").
//     One `TaskLimits` per PROCESS (daemon), shared by all sessions: `new TaskLimits(config)`.
//   - The Task tool exists only at depth 0 (`parent.depth < limits.maxDepth`); remove it from child tool sets
//     (`ChildOptions.removeTools`). Available per spec §5.1 (high autonomy or when subagents are enabled); gating is the lead's.
//   - Task execution: `await runTask(input, {parent, agents, limits, spawnChild, signal})`.
//       Foreground => `{report, summary, outcome}`: tool_result text = `report` (Script: `{report}`). Emit the summary
//       record (childSessionId, subagentType, description, status, toolUseCount, durationMs) in tool_progress_update
//       `subagentSessionId`, add the child's token usage to the parent totals, fire `hooks.subagentStop(...)`.
//       Background (`input.background`) => `{jobId, done}`: register the job with script_job; when `done` resolves,
//       wake the parent with the report. TaskError => tool_result isError with the message (limit/depth/unknown agent).
//   - `spawnChild(prompt, opts)` is the child-session machinery: create a Session with its own id/history starting from
//     `prompt` only, `opts.agentSystemPrompt` appended to the base system prompt, `opts.modelId`/`reasoningEffort`,
//     `opts.autonomy`, tools = `allowedTools ?? all` minus `removeTools`, enforce `inactivityTimeoutMs`, honour `opts.signal`,
//     and return `{childSessionId, status, report, toolUseCount, durationMs}`.
export * from "./agents.ts";
export * from "./task.ts";

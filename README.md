# Rigwell

Rigwell is a model-independent coding agent that runs on your own machine: a background daemon, a terminal
UI, a desktop app, Missions, local automations, git worktrees and a side pane with files, terminal, browser
and side chat.

This repo holds the build spec. There is no code yet.

## Files

| File | What it is |
|---|---|
| [`spec/harness-spec.md`](spec/harness-spec.md) | The build spec: protocol, agent loop, tools, permissions, storage, TUI (§1–§13), then the desktop app, Missions, automations, side pane, worktrees and notifications (§14–§19). §9 lists the build phases. |
| [`spec/prompts.md`](spec/prompts.md) | Original prompt and tool text for the agent, as templates. |
| [`spec/app-inventory.md`](spec/app-inventory.md) | A screen-by-screen inventory of the reference desktop app, checked against the spec. |

## Reading the spec

- Every fact carries a source tag, defined in §0 of the spec. **[DESIGN]** marks a choice for Rigwell, not
  something observed.
- Paths such as `~/.factory/...` describe the reference product. Rigwell uses its own names (§11).
- Scope (§1): everything that runs on the user's machine. Hosted parts are later phases. Items that need
  an owner decision are listed in §1.

# Desktop app (Phase 8)

An Electron app in `desktop/` that is one more client of the daemon. Everything that does agent work stays in the daemon.

## Run it

```
cd desktop && npm install      # downloads Electron 42.3.3
bun run build.ts               # writes desktop/dist
npx electron .                 # starts the app; it starts and supervises the daemon
```

Environment: `RIGWELL_HOME` (data folder), `RIGWELL_DAEMON_CMD` (JSON array that starts the CLI, default `["bun", "<repo>/src/cli/main.ts"]`),
`--route=/path` (first route). On Linux as root add `--no-sandbox`; headless needs an X server (`Xvfb`).

## Parts

| Part | Where |
|---|---|
| Main process: windows, menu, deep links, IPC, notifications, sounds | `desktop/main/main.ts` |
| Daemon supervisor (restart on crash) | `desktop/main/supervisor.ts` |
| Connection broker and attention tracking | `desktop/main/broker.ts`, `src/sidepane/attention.ts` |
| Browser pane CDP proxy | `desktop/main/cdp-proxy.ts` |
| Appearance before paint, alerts, settings, security helpers | `desktop/main/{appearance,alerts,settings,security}.ts` |
| Preload bridge (`window.rigwell`) | `desktop/preload/preload.ts` |
| Renderer (React) | `desktop/renderer/` |
| Daemon side pane services | `src/sidepane/{files,pty,browser,sidechat,index}.ts` |

## Daemon methods added (prefix `rigwell.`)

`daemon.list_sessions`, `daemon.list_files`, `daemon.search_files`, `daemon.get_workspace_file_content`, `daemon.write_workspace_file_content`
(stale write: error -32006), `daemon.create_terminal`, `daemon.write_terminal_data`, `daemon.resize_terminal`, `daemon.close_terminal`,
`daemon.list_terminals` (adopts and returns scrollback in `state.serialized`), `daemon.browser_attach`, `daemon.browser_detach`,
`daemon.browser_status`, `daemon.side_chat_ask`, `daemon.side_chat_list`, `daemon.side_chat_cancel`.
Notifications inside `session_notification`: `daemon.terminal_data`, `daemon.terminal_exit`, `daemon.side_chat_entry`.
Agent tool: `Browser`.

## Pages added in the gap wave

Routes: `#/missions`, `#/missions/<sessionId>`, `#/automations`, `#/automations/<id>`, and settings pages `session-defaults`, `missions`,
`custom-models`, `worktrees`, `connectors`, `session-management`, `usage`. The sidebar lists Mission Control and Automations, shows pinned
sessions first and hides archived ones, and has an Add folder button that runs the trust prompt. The session header menu has Pin, Rename and
Archive (`rigwell.pin_session`, `rename_session`, `archive_session`; `list_sessions` falls back to `daemon.list_sessions` on older daemons).
The composer has a searchable model picker, a Normal / Spec / Mission mode menu, and Connectors and Skills dialogs. Home has a Worktree toggle
(defaults to the `runInWorktree` setting). The browser pane can reopen closed tabs, move tabs, step to the next or previous tab and take a screenshot.
Main process helpers: `desktop/main/user-settings.ts` (masked settings file, trusted folders, setup profiles) and `desktop/main/skills.ts`.

## Tests

`bun test test/desktop` (no Electron needed except `electron.test.ts`, which skips itself when Electron, Playwright or Xvfb is missing).

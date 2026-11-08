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
The composer has a searchable model picker, a Normal / Spec / Mission mode menu, and Connectors and Skills dialogs. The Skills dialog searches skills, filters them by source (Built-in, User, Project) and has a Create skill form (`skills:create` in the main process). Attached images and images in sent messages open a preview with a toolbar (zoom, Fit, Rotate, Copy, Remove, Close). A fenced `email` block renders as a card with Copy and Open in mail app (`mailto:`). Copy buttons use `clipboard:writeText` and `clipboard:writeImage` in the main process, because the page has no clipboard permission. Home has a Worktree toggle
(defaults to the `runInWorktree` setting). The browser pane can reopen closed tabs, move tabs, step to the next or previous tab and take a screenshot.
Main process helpers: `desktop/main/user-settings.ts` (masked settings file, trusted folders, setup profiles) and `desktop/main/skills.ts`.

## Packaging, fuses and updates

```
cd desktop && npm install
bun run package:linux     # AppImage + deb in desktop/release (also release/linux-unpacked)
bun run package:mac       # dmg + zip   (config only; must run on macOS)
bun run package:win       # NSIS        (config only; run on Windows or with wine; set RIGWELL_BUN_BIN to a Windows bun.exe)
```
`bun run desktop` is the same as `package` for the host platform. The packaged app carries the bun runtime and the daemon sources in
`resources/`, and starts its daemon from them. Fuses are flipped in `packaging/fuses.cjs` (decision 285).

Update feed: set `updateFeedUrl` in Settings > General, or `RIGWELL_UPDATE_URL`. The URL is a folder holding `latest-linux.yml`,
`latest-mac.yml` and `latest.yml` as electron-builder writes them (or one .yml/.yaml/.json file):

```yaml
version: 1.4.0
releaseDate: '2026-11-01T00:00:00.000Z'
releaseNotes: Faster startup
files:
  - url: rigwell-1.4.0-x86_64.AppImage   # relative to the feed, or absolute
    sha512: ...
    size: 178823051
```
Help > Check for Updates compares `version` with the app version.

## Renderer stack

React 19, xterm.js, tiptap (composer), shiki (code), KaTeX (math) and mermaid (diagrams). Markdown: `$x$` and `$$...$$` are math, a
```mermaid fence is a diagram. TanStack and Jotai are not used (decision 287).

## Tests

`bun test test/desktop`. The Electron and Chromium tests skip (printing the cause) when Electron, Playwright, Chromium or Xvfb is missing. `packaging.test.ts` needs a built Linux package (`RIGWELL_BUILD_PACKAGE=1` builds one).

## Wave 4 features (owner approved)

| Feature | Where | Notes |
|---|---|---|
| Voice dictation | composer microphone button, Ctrl+Shift+D, Settings > Voice dictation | offline first, see below |
| API keys, environments, accounts | Settings > API keys, Environments, Accounts | secrets are write-only; sign-in uses `auth_*` |
| Tray icon | Settings > General > Tray icon | Show/Hide, active sessions, attention, Quit |
| Chrome cookie import | Browser tab > Import cookies | explicit, per site, never logged |
| Automation templates, overview, guided setup | Automations page | uses `docs/automations.md` methods |
| Spec handoff | Spec prompt | "Hand off to a new session" options with context savings |
| `[managed by org]` labels | settings headings | org file from `RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH` |

### Voice dictation

By default nothing is configured, and the microphone button explains how to enable it. Recording happens in the window; the audio goes only to the backend you choose.

- Local command: install whisper.cpp (`whisper-cli`) and a ggml model, then Settings > Voice dictation > Local command, and set the model path. Or give a full command line with `{file}` for the recording: `whisper-cli -m /models/ggml-base.en.bin -f {file} -nt -np`. The Python `whisper` CLI works too (`whisper {file} --model base`).
- Remote endpoint: an OpenAI-compatible `.../audio/transcriptions` URL. The recording is sent to that server. The API key is read from the environment variable you name; it is not stored in a file.

### Signed Linux updates (spec 14.5)

Linux updates are installed only if their Ed25519 signature verifies against a public key you configure. No key ships with the app, so out of the box Linux updates are refused with a message saying so.

```
bun desktop/packaging/sign-update.ts keygen ~/rigwell-keys        # writes update-private.pem, prints the public key
bun desktop/packaging/sign-update.ts sign ~/rigwell-keys/update-private.pem rigwell-1.4.0-x86_64.AppImage   # writes <file>.sig
```

Put the printed public key in Settings > General > Update public key (or set `RIGWELL_UPDATE_PUBLIC_KEY`), publish the `.sig` next to the artifact (or add `signature: <base64>` to its entry under `files:` in `latest-linux.yml`), and keep the private key off the feed host. A bad signature, a changed file, a missing signature or a wrong `sha512` / `size` refuses the update and leaves nothing on disk.

### Chrome cookie import

Browser tab > Import cookies. Pick a Chrome or Chromium profile, press Show sites (only host names and counts are read), tick the sites and Import. Only those sites' cookies are copied into the browser pane. On macOS the system may ask for access to "Chrome Safe Storage"; on Linux the key comes from libsecret (`secret-tool`) or Chrome's fixed fallback. Windows is not supported. `RIGWELL_CHROME_USER_DATA_DIR` selects another Chrome folder.

### Icons and the tray

`desktop/assets/icon.svg` is the source. `cd desktop && bun run packaging/build-icons.ts` regenerates `assets/icons/*.png`, `icon.ico`, `icon.icns` and `assets/tray/*.png` (needs the Playwright Chromium). The generated files are committed.

### Tests for these features

`bun test test/desktop/electron-wave4.test.ts` drives the real app: dictation with a fake speech-to-text program, secrets, OAuth against `test/fakes/fake-oauth.ts`, org labels, templates, overview and guided setup, tray (through the `RIGWELL_TEST_HOOKS=1` hook), spec handoff and cookie import with a synthetic database. Unit tests: `chrome-cookies`, `update-verify`, `dictation`, `tray`, `wave4-lib` in `test/desktop`, `test/tui/login.test.ts`.

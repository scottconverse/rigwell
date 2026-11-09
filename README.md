# Rigwell

Rigwell is a coding agent that runs on your own machine, with the model you choose. One local daemon serves
a terminal UI, a desktop app, a headless `exec` mode and a TypeScript SDK. It reads, edits and runs code in your
repo, and commands above the autonomy level you set wait for your approval.

**[Website](https://scottconverse.github.io/rigwell/)** ·
**[User manual](https://scottconverse.github.io/rigwell/manual/)** ·
[Quick start](#quick-start) ·
[Download v0.3.0](https://github.com/scottconverse/rigwell/releases/tag/v0.3.0) ·
[Issues](https://github.com/scottconverse/rigwell/issues)

## What it does

- **Any model.** Adapters for Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat Completions
  (for example a local Ollama), Google Gemini and Amazon Bedrock Converse. Models are entries in `settings.json`.
- **Bounded autonomy.** Four levels (off, low, medium, high). The default is off (read-only). The model labels
  each command with a risk level, and allow, deny and block lists apply on top. Commands can run in a sandbox
  (bubblewrap on Linux, sandbox-exec on macOS). Edits are snapshotted so you can rewind.
- **MCP connectors with sign-in.** Connect stdio, streamable HTTP and SSE MCP servers. Since 0.2.0: OAuth
  sign-in for HTTP and SSE servers (`rigwell mcp login <name>`, or Sign in in the desktop app).
- **Script mode.** The model can write a short script that calls the tools as functions, so many tool calls
  take one model request.
- **More than one chat.** Missions, local automations (schedules and local webhooks), git worktrees with pull
  requests, spec mode, a side pane, skills, hooks, subagents and custom slash commands.
- **Built to be driven by programs.** A documented JSON-RPC protocol over stdio, a Unix socket and a
  token-protected loopback WebSocket, plus a TypeScript SDK.
- **Eval loop.** `rigwell eval` runs coding tasks against your models and compares a build to the one before.

## Quick start

Download the installer from the [v0.3.0 release](https://github.com/scottconverse/rigwell/releases/tag/v0.3.0).
Windows x64 is the release target. Linux AppImage and deb builds are extras. There is no macOS build in 0.3.0
(v0.1.0 has one). The installers are not signed, so Windows SmartScreen shows a warning.

To run from source you need Bun 1.4 or later, `git` and `rg` (ripgrep) on your PATH.

```bash
git clone https://github.com/scottconverse/rigwell
cd rigwell
bun install
```

Add a model to `~/.rigwell/settings.json` (or `$RIGWELL_HOME/settings.json`):

```json
{ "customModels": [ { "model": "your-model-id", "displayName": "My model", "provider": "anthropic",
                      "baseUrl": "https://api.anthropic.com", "apiKey": "${ANTHROPIC_API_KEY}" } ] }
```

Run it:

```bash
bun src/cli/main.ts                                    # terminal UI
bun src/cli/main.ts exec --auto low "Fix the failing test"
bun src/cli/main.ts daemon                             # daemon for the desktop app and SDK
bun test                                               # the test suite
```

The desktop app is in `desktop/`. See [docs/desktop.md](docs/desktop.md).

## Documentation

The **[user manual](https://scottconverse.github.io/rigwell/manual/)** is the full guide. It covers install,
models, autonomy, tools, MCP and OAuth, automations, missions, the architecture (with diagrams), every
JSON-RPC method and notification, every local HTTP and WebSocket path, the CLI, configuration, environment
variables, the SDK, files on disk and the security model.

| Doc | What it covers |
|---|---|
| [User manual](https://scottconverse.github.io/rigwell/manual/) | Everything, in one page ([source](website/manual/index.html)) |
| [docs/clients.md](docs/clients.md) | The SDK, the daemon WebSocket and the TUI |
| [docs/desktop.md](docs/desktop.md) | The desktop app |
| [docs/automations.md](docs/automations.md) | Automation methods, templates and the visual page |
| [docs/auth.md](docs/auth.md) | Account sign-in, secrets and environments |
| [docs/eval.md](docs/eval.md) | The eval loop |
| [docs/decisions.md](docs/decisions.md) | Choices made where the spec was silent |
| [spec/harness-spec.md](spec/harness-spec.md) | The build spec |
| [website/](website/) | The website source (static HTML, CSS and JS) |

## Project status

Early. Version 0.3.0 is the third release. Every part of the local build spec is written and tested, but
all tests use fake servers, and Rigwell has not had wide real-world use. CI runs the tests on Windows and
Linux. It is run by hand on Windows only.

Known limits:

- No command sandbox on Windows. The sandbox is off by default everywhere.
- MCP OAuth sign-in is tested against a local fake server only.
- Chrome cookie import does not work on Windows.
- Hosted parts and Workstreams for Missions are planned, not built.
- The SDK is not published to npm.

Open issues are in [docs/handoff/HANDOFF.md](docs/handoff/HANDOFF.md).

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/scottconverse/rigwell/issues).
Run `bun test` and `bun run typecheck` before you open a pull request.

## Attribution

Rigwell's wire protocol shapes (the JSON-RPC message, notification and settings types) are adapted from the
type definitions of the Apache-2.0 licensed `@factory/droid-sdk` 0.10.0. See [`NOTICE`](NOTICE). This is an
attribution only: Rigwell is its own product and uses its own names everywhere else.

## License

Rigwell is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only); see [`LICENSE`](LICENSE).
Third-party attributions are in [`NOTICE`](NOTICE).

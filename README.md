# Rigwell

Rigwell is a coding agent that runs on your own machine, with the model you choose. One local daemon serves
a terminal UI, a desktop app, a headless `exec` mode and a TypeScript SDK. It reads, edits and runs code in your
repo, and commands above the autonomy level you set wait for your approval.

[Website](website/) · [Quick start](#quick-start) · [Documentation](#documentation) · [Issues](https://github.com/scottconverse/rigwell/issues)

## What it does

- **Any model.** Adapters for Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat Completions,
  Google Gemini and Amazon Bedrock Converse. Models are entries in `settings.json`.
- **Bounded autonomy.** Four levels (off, low, medium, high). The model labels each command with a risk level.
  Commands can run in a sandbox (bubblewrap on Linux, sandbox-exec on macOS). Edits are snapshotted so you can
  rewind.
- **Script mode.** The model can write a short script that calls the tools as functions, so many tool calls
  take one model request.
- **More than one chat.** Missions, local automations (schedules and local webhooks), git worktrees with pull
  requests, a side pane, skills, hooks, subagents and MCP connectors.
- **Eval loop.** `rigwell eval` runs coding tasks against your models and compares a change to a baseline.

## Quick start

Download the installer from the [latest release](https://github.com/scottconverse/rigwell/releases/latest). Windows is the release target; the macOS and Linux
builds are extras. The installers are not signed.

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
bun test                                               # the test suite
```

The desktop app is in `desktop/`. See [docs/desktop.md](docs/desktop.md).

## Documentation

| Doc | What it covers |
|---|---|
| [docs/clients.md](docs/clients.md) | The SDK, the daemon WebSocket and the TUI |
| [docs/desktop.md](docs/desktop.md) | The desktop app |
| [docs/automations.md](docs/automations.md) | Automation methods, templates and the visual page |
| [docs/auth.md](docs/auth.md) | Account sign-in, secrets and environments |
| [docs/eval.md](docs/eval.md) | The eval loop |
| [docs/decisions.md](docs/decisions.md) | Choices made where the spec was silent |
| [spec/harness-spec.md](spec/harness-spec.md) | The build spec |
| [website/](website/) | The landing page source (static HTML and CSS) |

## Project status

Early. Every part of the local build spec is written and tested, and CI runs the tests on Linux, macOS and
Windows. Version 0.1.0 is the first release. It has not had wide real-world use. Hosted parts and
Workstreams for Missions are planned, not built. OAuth sign-in for MCP servers is new and was tested only
against a local fake server. Known issues are in
[docs/handoff/HANDOFF.md](docs/handoff/HANDOFF.md).

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/scottconverse/rigwell/issues).

## Attribution

Rigwell's wire protocol shapes (the JSON-RPC message, notification and settings types) are adapted from the
type definitions of the Apache-2.0 licensed `@factory/droid-sdk` 0.10.0. See [`NOTICE`](NOTICE). This is an
attribution only: Rigwell is its own product and uses its own names everywhere else.

## License

Rigwell is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only); see [`LICENSE`](LICENSE).
Third-party attributions are in [`NOTICE`](NOTICE).

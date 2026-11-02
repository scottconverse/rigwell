# Rigwell

Rigwell is a model-independent coding agent that runs on your own machine: a background daemon, a terminal
UI, a desktop app, Missions, local automations, git worktrees and a side pane with files, terminal, browser
and side chat.

This repo holds the build spec and the Phase 1 code (core loop): the daemon, `rigwell exec`, an
Anthropic and an OpenAI Responses adapter, six direct tools, permissions, and session storage.

## Files

| File | What it is |
|---|---|
| [`spec/harness-spec.md`](spec/harness-spec.md) | The build spec: protocol, agent loop, tools, permissions, storage, TUI (§1–§13), then the desktop app, Missions, automations, side pane, worktrees and notifications (§14–§19). §9 lists the build phases. |
| [`spec/prompts.md`](spec/prompts.md) | Original prompt and tool text for the agent, as templates. |
| [`spec/app-inventory.md`](spec/app-inventory.md) | A screen-by-screen inventory of the reference desktop app, checked against the spec. |
| [`evidence/`](evidence/README.md) | Raw captures and session files behind the spec's [RUN] facts. Reference only: do not copy their text into Rigwell. |

## Reading the spec

- Every fact carries a source tag, defined in §0 of the spec. **[DESIGN]** marks a choice for Rigwell, not
  something observed.
- Paths such as `~/.factory/...` describe the reference product. Rigwell uses its own names (§11).
- Scope (§1): everything that runs on the user's machine. Hosted parts are later phases. Items that need
  an owner decision are listed in §1.

## Phase 1: running it

Needs Bun 1.4+, `git` and `rg` on PATH.

```bash
bun install
bun test
```

Models are configured as `customModels` in `~/.rigwell/settings.json` (or `$RIGWELL_HOME/settings.json`):

```json
{ "customModels": [ { "model": "claude-x", "displayName": "My Claude", "provider": "anthropic",
                      "baseUrl": "https://api.anthropic.com", "apiKey": "${ANTHROPIC_API_KEY}" } ] }
```

```bash
rigwell exec --auto low "Fix the failing test"
rigwell exec --input-format stream-jsonrpc --output-format stream-jsonrpc
rigwell daemon --socket /tmp/rigwell.sock
```

Run `bun src/cli/main.ts` in place of `rigwell` when it is not installed. Choices made where the spec
was silent are in [`docs/decisions.md`](docs/decisions.md).

## Attribution

Rigwell's wire protocol shapes (the JSON-RPC message, notification and settings types) are adapted from the
type definitions of the Apache-2.0 licensed `@factory/droid-sdk` 0.10.0. See [`NOTICE`](NOTICE). This is an
attribution only: Rigwell is its own product and uses its own names everywhere else.

## License

Rigwell is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only); see [`LICENSE`](LICENSE).
Third-party attributions are in [`NOTICE`](NOTICE).

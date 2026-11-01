# Evidence for the spec's [RUN] facts

Raw files behind the spec's **[RUN]** tags (§0), copied Nov 1 2026 from the research folder. The spec
cites them by their original paths. This table maps each path to its copy here.

| Spec cites | Copy here | What it is |
|---|---|---|
| offline capture runs (Linux CLI 1.0.0, fake model server) | `capture/` | `scripts/` and `linux/`: the capture scripts and fake Anthropic server. `out-wsl/out/` = runs A–C, `out-wsl2/out/` = runs D–L (request bodies, stdout, logs, screens). The `.tgz` files hold the same output. |
| `bench-data/cli-runs/*/jsonrpc.jsonl` | `bench/cli-runs/` | Five JSON-RPC captures (CLI protocol 1.286.0, local mock model), each with `summary.json`. |
| `bench-data/app-sessions` | `bench/app-sessions/` | Desktop-app session transcripts (T1, T3). |
| benchmark notes | `bench/benchmark-plan.md`, `bench/benchmark-results.md` | Plan and results of the Oct 30 pilot. |
| bench driver and tasks | `bench/driver/`, `bench/tasks/`, `bench/tools/`, `bench/*.py` | Driver (`npm install` to restore `node_modules`), task repos, graders, tally scripts. |
| real files under `~/.factory` | `factory-home/` | `sessions/`, `snapshots/`, `state/`, `droids/`, `cache/session-index/`, `settings.json`, `host.json`. |

## Not copied

- Login files (`auth.*`, keyring) and the org settings cache: account data.
- `logs/`, `telemetry/` and the other housekeeping folders under `~/.factory`.
- The unpacked CLI binary (347 MB). Get it from the public npm package `@factory/cli-linux-x64` 1.0.0.

## Rules for this folder

- The request bodies, logs and session files contain Factory's own prompt and tool text. **Read it to
  check a fact. Do not copy that text into Rigwell's code, prompts or docs.** Rigwell's prompts are in
  `spec/prompts.md`.
- Paths in these files are from the research machine. They are not paths Rigwell should use.

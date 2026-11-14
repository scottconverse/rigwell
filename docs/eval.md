# Eval loop (spec section 8)

`rigwell eval` measures the harness per model: pass rate, cost, wall time, tokens, requests and cache hit rate,
per task, and compares each run to the previous build.

## Tasks

`eval/tasks/<name>/`:

| File | Purpose |
| --- | --- |
| `repo/` | Starting fixture. Copied to a temp dir (and committed with git) for every trial. |
| `prompt.txt` | The prompt sent to the agent. |
| `task.json` | `grader` (shell command, exit 0 = pass) and optional `budget`: `timeoutMs`, `maxRequests`, `maxCostUsd`. |
| grader files | Live beside `repo/`, not inside it, so the agent never sees them. The grader runs with the working copy as cwd and `$EVAL_TASK_DIR` pointing at the task folder. |

A trial that goes over budget fails without running the grader. The shipped suite has 43 original, self-contained coding tasks, including the three earlier fixtures. No task installs packages or needs a network connection. This is authored task coverage, not a real-agent benchmark result.

| Category | Tasks |
| --- | --- |
| bug-fix (9) | csv-quoted-fields, deep-merge-own-keys, fix-greeting-typo, json-pointer-escaping, lru-read-refresh, money-integer-cents, numeric-version-sort, query-repeat-encoding, rate-window-boundary |
| feature (9) | abortable-retry, add-clamp, async-map-limit, canonical-json-key, dependency-topological-sort, interval-union, recursive-secret-redaction, stable-priority-queue, stream-event-decoder |
| multi-file (9) | abortable-import-pipeline, clock-injected-ttl, idempotent-order-service, layered-settings-nullish, metrics-counter-labels, rename-constant, rename-user-contract, repository-page-contract, typed-service-errors |
| refactor (4) | extract-invoice-format, immutable-ranking, inject-config-environment, streaming-file-digest |
| terminal (6) | cli-argument-parser, cli-atomic-copy, cli-file-summary, cli-json-config-migration, cli-jsonl-validation, cli-search-exit-status |
| tests (6) | tests-case-normalization, tests-date-leap-years, tests-object-pick, tests-page-offset, tests-range-boundaries, tests-unique-order |

Each task has a starting repo, a concrete contract, category metadata, a check command and a bounded trial. New tasks have a five-minute/30-request budget. The eval tasks command lists them; --tasks still accepts external suites.

The task-suite test executes every actual grader on a fresh untouched copy (must fail) and another fresh copy with a reference patch (must pass). Reference patches live outside the trial repo under test/eval. Six test-writing graders require tests that pass valid code and catch every isolated targeted regression. Implementation must remain unchanged; CRLF/LF differences are normalized. Fixture test files are named checks.cjs so Bun cannot run benchmark placeholders as harness tests. Grader-created files are discarded between controls.

Graders execute trusted local commands with the owner's permissions. Keeping graders and references outside the trial working directory avoids accidental inclusion in the agent's project; it is not a security boundary against an agent reading arbitrary machine paths. Inspect third-party grader commands before running them.

## Config

`$RIGWELL_HOME/eval/config.json` (or `--config`). Without it, every custom model in settings runs, unpriced.

```json
{
  "autonomy": "medium",
  "trials": 3,
  "timeoutMs": 600000,
  "models": [
    { "id": "custom:My-Model-0", "family": "my-family",
      "prices": { "inputPerMtok": 3, "cachedInputPerMtok": 0.3, "outputPerMtok": 15, "cacheWritePerMtok": 3.75 } }
  ],
  "variants": [
    { "name": "baseline" },
    { "name": "script-on", "hypothesis": "Script mode cuts requests", "toolExecutionMode": "script_only" }
  ]
}
```

Prices are USD per million tokens. Cost = uncached input x `inputPerMtok` + cache reads x `cachedInputPerMtok` +
cache writes x `cacheWritePerMtok` (default: the input price) + output x `outputPerMtok`. A model with no
`prices` is reported as unpriced and gets no cost deltas or cost flags. Permission requests during an eval are
declined, so autonomy decides what can run.

## Running

```
rigwell eval run [--config f] [--task a,b] [--model id,id] [--trials n] [--auto low|medium|high] [--build id]
```

Each trial starts `rigwell exec --input-format stream-jsonrpc` and uses only the wire protocol. Results are saved
to `$RIGWELL_HOME/eval/runs/<buildId>/<timestamp>.json`. `buildId` is the git short sha of the Rigwell checkout,
or `--build`.

## Report

```
rigwell eval report --since 7d [--build id] [--against id] [--json] [--out file]
```

Takes the latest run in the window and the latest run of the most recent earlier, different build, and prints
Markdown (or JSON): per model and variant pass rate, mean cost, cost per pass, mean time, time per pass, requests,
cache hit rate, and deltas. It flags regressions: any pass-rate drop (overall or per task), mean cost up more than
20%, mean time up more than 25%. Following the spec's methodology, cost and time deltas are also shown on the tasks
that passed every trial in both builds. Failures that repeat across at least two tasks and two models are listed
as clusters (the input to failure mining).

## Variants (proposals)

A variant is a config-only change, applied through the public surface: its `settings` object is written to a
temporary file passed as `--settings`, and `toolExecutionMode` goes to `initialize_session`. Run a `baseline`
variant next to the candidate. The report then compares them per model and per family and recommends `ship`
(holds on every family), `per-model option` or `do not ship`. A human decides what ships.

## Weekly automation

Create `~/.rigwell/automations/weekly-eval/HEARTBEAT.md`:

```
---
name: Weekly eval
schedule: weekly
autonomy: high
workingDirectory: /path/to/rigwell
---
Run `rigwell eval run --trials 3`, then `rigwell eval report --since 7d --out reports/weekly.md`.
Summarize any regressions at the top of the final message.
```

The automation scheduler (spec section 16) runs it every Monday and catches up once after a sleep.

## Real adapter smoke acceptance

After the owner configures profiles and credentials through settings and the credential store, use the existing eval run CLI with a one-trial config and --task fix-greeting-typo --trials 1. Select one owner-configured profile for each adapter: Anthropic, OpenAI HTTP and WebSocket, Gemini, configured Bedrock paths, and a free local Chat Completions endpoint. Keep credentials and real-run configuration outside the repository and CI. Report exact candidate, adapter/profile, command and grader result. Missing profiles remain pending acceptance. Fake CLI integration covers one task per category without real-provider requests.

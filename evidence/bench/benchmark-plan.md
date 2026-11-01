# Benchmark plan: do the post's claims hold? (Oct 30 2026)

Status: **plan only. Nothing here has been run.** Every run in Phase 1 and Phase 2 spends Scott's
paid usage and needs his approval first. Phase 0 spends nothing.

Source: https://factory.com/news/frontier-harness (dated Oct 29 2026), re-read today.

## 1. Which claims to test

| # | Claim in the post | Testable on a small budget? |
|---|---|---|
| A | Script mode costs **15% less** than direct tool calls on Claude Opus 5.5 | **Yes.** Same model, same tasks, mode switched. Main test. |
| B | Many-call jobs take **~2 model requests** in Script mode instead of dozens (Linear: 2 vs ~36; CI sweep: 2 vs 59–187) | **Yes.** One task built for many tool calls. |
| C | Typical request reads **98%** of its input from cache (91.5% token-weighted) | **Partly.** Totals from `-o json`; per-request share only if the stream reports it (not checked). |
| D | `droid exec` reaches its first model request in **646 ms** median | **Partly, for free** on the local mock (Phase 0). Offline, so the network part is missing. |
| E | vs Claude Code on Opus 5.5: **+3.0 to 7.6 points**, **26% less time** and **17% fewer tokens** per passed task, up to **24% lower cost** | **Direction only.** A point gap needs the full Terminal-Bench 4 at 3 trials. Optional arm; it also spends Claude usage. |
| F | vs Codex on GPT-6.1 Sol: +3.5 points, 12% lower cost, 10% longer | **Not in this plan** (no Codex install; same Terminal-Bench problem). |

Out of scope: the app timings (first paint 488 ms, quit 30 ms), production telemetry, and anything
needing Terminal-Bench 4 in full.

## 2. What `droid exec` gives us (checked today, bundled `droid.exe` 1.0.0)

- **Measurement.** `-o json` prints one result line with `duration_ms`, `num_turns`, `is_error`,
  `session_id` and `usage` holding `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `thinking_tokens`, `ttft_ms` and `factory_credits`. Seen in the
  offline captures. Whether `num_turns` counts model requests or user turns is **not checked**.
  `-o stream-json` gives per-event output; whether it carries per-request usage is **not checked**.
- **Model and effort.** `-m claude-opus-5-5 -r high` (the post used high reasoning).
- **Autonomy.** `--auto medium` lets it edit files and run tests. Never `--skip-permissions-unsafe`.
- **Forcing Script vs direct mode.** There is **no exec flag** for it. In the code:
  - mode = `direct_only` if the model is not on the server's Script list, else the session override,
    else `script_only`. Opus 5.5 is on Scott's live Script list.
  - The override is the session setting `toolExecutionMode` with values `direct_only` / `script_only`.
    It is set through the JSON-RPC session settings (`droid exec --input-format stream-jsonrpc
    --output-format stream-jsonrpc`, the path the SDK uses). The `--settings` file is **not checked**
    as a way to set it.
- `--list-tools` does not show Script, so it can't confirm the mode. The mode must be confirmed from
  each run's events (Script calls present or absent).

## 3. Phases

### Phase 0: free checks (no usage)

1. Build the driver: a small Node script that starts `droid exec` in stream-jsonrpc mode, sets
   model, effort, autonomy and `toolExecutionMode`, sends one prompt, and saves every event.
2. Run it against the offline mock model in WSL, as in the earlier captures. Check that
   `direct_only` and `script_only` change the tools in the captured request. A custom model whose
   base model is `claude-opus-5-5` may count as on the Script list (**not checked**; if not, this
   check moves to the Phase 1 pilot).
3. Claim D: time from process start to the first request reaching the mock, 10 runs. Report it as
   offline-only.
4. Build the task repo and graders (section 4) and check each grader fails on the untouched repo.

### Phase 1: pilot (small spend, then stop)

- 2 tasks (T1 many-call, T3 one bug fix) × 2 modes × 1 trial = **4 runs** on Opus 5.5, high.
- Read `factory_credits` and tokens from each run. Confirm the mode from the events.
- **Stop and report to Scott**: credits used, projected credits for Phase 2, anything broken.

### Phase 2: main run (only after Scott approves the projection)

- 6 tasks × 2 modes × 3 trials = **36 runs**, Opus 5.5, high, `--auto medium`.
- Optional arm E (separate approval): the same 6 tasks × 3 trials in Claude Code on Opus 5.5.

## 4. Task set (my design, small and graded by script)

Each task is a fresh copy of a small Python repo in the scratchpad, with a `pytest` grader the
agent cannot see. A task passes only if the grader passes.

| Task | What it asks | Why |
|---|---|---|
| T1 | Count and list which of 300 log files contain a failed job, write `report.json` | Many calls (claim B; CI-sweep analogue) |
| T2 | Rename a function used in ~40 files, keep tests passing | Many edits |
| T3 | Fix one bug that a failing test shows | Few calls; Script should be about even |
| T4 | Find every config file with a bad value among 150 and fix them | Search, read, filter, edit |
| T5 | Add a small feature with tests | Ordinary coding |
| T6 | Move a helper into its own module across 5 files | Small refactor |

Limit: 15 minutes per run. The post's own case (Script savings come from runs with 6+ tool calls)
means T1, T2 and T4 should show the largest gap if the claim holds.

## 5. Metrics and analysis (as in spec §8)

Per run: pass or fail, `factory_credits`, input/output/cache-read tokens, `duration_ms`, model
request count (from events), Script call count.

Per mode: pass rate, then **credits, tokens and time per passed task**, using only tasks both modes
passed in all trials (the post's rule). Cache-read share = cache-read ÷ (input + cache-read) per
run, per request if the stream gives it.

How to read the result:
- Claim A holds if Script is about 15% cheaper per passed task over the 6 tasks.
- Claim B holds if T1 takes a handful of requests in Script mode and many more in direct mode.
- Six tasks × 3 trials is small. It can show direction and rough size, not a precise percentage.

## 6. Cost and stop rules

- Cost per run is **not known** (credit price and Pro plan allowance not checked). The pilot
  measures it before any larger spend.
- Stop at once on: an out-of-credits or usage-exhausted error; any run over 2× the pilot's highest
  credit use; a total over the cap Scott sets; any run touching files outside its task copy.
- Never: `--skip-permissions-unsafe`, git push, network installs beyond the task's own `pip install`.

## 7. Outputs

- `specs/benchmark-results.md`: tables per claim, marked held / did not hold / not settled.
- Raw events and result lines kept in the scratchpad.
- The spec's §10 "Cannot be settled: benchmarks" line updated with what was settled.

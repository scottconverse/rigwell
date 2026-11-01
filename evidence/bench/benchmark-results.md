# Benchmark results (Oct 30 2026)

Plan: `specs/benchmark-plan.md`. Approved by Scott: Phase 0 (free) and the Phase 1 pilot (4 paid runs),
plus the same pilot tasks in the Factory desktop app. Phase 2 (36 runs) is **not approved yet**.

## Phase 0: free checks (offline mock, no usage)

Setup: bundled `droid.exe` 1.0.0 on Windows, a throwaway Factory home, airgap env, and a local mock
of the model API on 127.0.0.1:18090 (port 18080 was in use by another app). The model was a custom
model pointing at the mock.

| Check | Result |
|---|---|
| Driver works (stream-jsonrpc, the SDK's path) | **Yes.** One session ran end to end and saved every message. |
| Session override `toolExecutionMode` is accepted | **Yes.** It is sent in `droid.initialize_session`, and the reply's settings report the mode in effect. |
| Mock model can run in Script mode | **No.** Asked for `script_only`; the reply said `direct_only`, and the request carried the 15 direct tools (Read, LS, Execute, Edit, Grep, Glob, Create, …). This matches the code: a model not on the server's Script list is forced to direct. So the mode check moves to the paid pilot. |
| Claim D: `droid exec` start to first model request | **Median 632 ms** over 10 runs (min 600, max 668). The post says 646 ms. Offline, so no network time is included. |
| Graders | All 6 fail on the untouched repo and pass on a reference solution. |

Side note: the mock run's result reported `factoryCredits: 19989` for 12,443 input and 10 output tokens.
That number came from the client with no Factory server involved, so it is a local estimate. How it
maps to Scott's plan allowance is **not checked**.

## Phase 1: pilot (Opus 5.5, high, medium autonomy)

Run with Scott's stored login through the bundled `droid.exe`. No API key was used. Each run used a
fresh task copy, `toolExecutionMode` set in `droid.initialize_session`, and a hidden grader.

| Run | Mode in effect | Passed | Credits | Model requests | Tool calls (model / inside scripts) | Wall time |
|---|---|---|---|---|---|---|
| T3 bug fix | script_only | yes | 21,634 | 3 | 2 Script / 6 | 19.4 s |
| T3 bug fix | direct_only | yes | 47,193 | 3 | 4 / 0 | 15.8 s |
| T1 log triage | script_only | yes | 29,771 | 3 | 2 Script / 6 | 23.4 s |
| T1 log triage | direct_only | yes | 60,213 | 5 | 4 / 0 | 38.0 s |

All four runs passed. **Total: 158,811 credits.** Each run also made one small side request first
(436 tokens in, about 10 out, 166–197 credits) that is counted in its total. It is the session title request.
The `session_title_updated` event ("Fix wrap.py test failures" in T3) arrives at the same moment
as that usage step (checked).

### How it was measured (checked)

- The mode in effect comes from the session settings in the reply to `droid.initialize_session`.
  Both modes took effect as asked.
- Per-request usage comes from `session_token_usage_changed`. Each event carries running totals,
  and each step up is one model request.
- Tool calls the model made have `toolu_…` ids. Calls made inside a script have `<uuid>-N` ids.
- The model's ids begin with `toolu_bdrk_`, which is the id format Amazon Bedrock uses. This
  suggests Opus 5.5 is served through Bedrock for this account (**inferred**).

### Per request (credits; share of input read from cache)

| Run | Request 1 | Request 2 | Request 3 | Request 4 | Request 5 |
|---|---|---|---|---|---|
| T3 script | 11,011 (82%) | 6,418 (94%) | 4,039 (97%) | | |
| T3 direct | **37,759 (0%)** | 5,396 (97%) | 3,872 (97%) | | |
| T1 script | 13,323 (81%) | 10,211 (93%) | 6,040 (94%) | | |
| T1 direct | **37,623 (0%)** | 5,169 (97%) | 6,093 (98%) | 4,739 (96%) | 6,394 (99%) |

Median cache-read share per request: 93–97% across runs. The post says 98% median (claim C:
close, but this is a small sample).

### What it says about the claims

- **A (Script mode costs 15% less): not settled.** Script mode used 54% and 51% fewer credits here.
  Almost all of the gap is the first request in direct mode, which read nothing from cache and cost
  about 37,700 credits both times. In Script mode the first request read 81–82% from cache.
  After the first request, the two modes are close:
  - T3: script 10,457 vs direct 9,268;
  - T1: script 16,251 vs direct 22,395.
  
  So the result depends on whether the prompt prefix is already cached:
  - **Observed:** in direct mode, a run on a new folder starts with a cold cache, even 2 minutes
    after another direct run.
  - **Inferred:** something run-specific, such as the working folder, sits early in the
    direct-mode prompt. Not checked.
  
  One trial per cell cannot separate these effects.
- **B (many-call jobs need far fewer requests): partly supported.** T1 took 3 requests in Script
  mode vs 5 in direct mode. Both are small, because Opus solved T1 with 4 shell commands in direct
  mode and did not make hundreds of calls. T1 is not a strong enough many-call task to reproduce the
  post's 2 vs 59–187.
- **C (98% cache read): roughly consistent** (93–97% median per run), apart from the cold first
  request.
- **D (646 ms to first request): consistent** (632 ms offline, Phase 0).

### Projection for Phase 2 (36 runs, needs Scott's approval)

- The pilot averaged **39,700 credits per run** (21,600 to 60,200).
- 36 runs × about 40,000 is **about 1.4 million credits**. T2, T4 and T5 touch more files than T1
  and T3, so plan for **1.4 to 3 million**.
- Against the plan: the app's Usage page showed 1% of the monthly allowance used after about
  165,000 credits of runs (see the app section below). If that holds, 1.4 to 3 million credits is
  roughly **8% to 18% of a month**. This is a rough estimate from whole-percent bars. How much
  of the 5-hour limit one burst would use is not checked: the 5-hour window may not include the
  earlier pilot runs.

Suggested changes before Phase 2 (for Scott to approve or drop):

1. Warm the cache the same way for both modes, or report cost with and without the first request.
2. Make T1 heavier, so direct mode needs many calls (for example, logs that must be read one by
   one rather than grepped).

## Factory desktop app: same pilot tasks

Run Oct 30 2026 by computer use in the Factory desktop app (`factory-desktop.exe`), logged in with
Scott's paid account. Model left on **Auto** (the app's default router), autonomy **Medium**. Each run
used a fresh copy of the task repo and the same prompt text as the pilot, then the same hidden grader.
Numbers come from the app's own session files (`~/.factory/sessions/<folder>/<id>.jsonl` and
`.settings.json`; the app writes the same files as the CLI).

| Run | Model the router picked | Mode in effect | Passed | Credits | Assistant turns | Tool calls | Time (first to last message) |
|---|---|---|---|---|---|---|---|
| T3 bug fix | gpt-6-luna, xhigh (reason "task_fit") | direct_only | yes | 2,786 | 5 | 8 (TodoWrite 3, Read 2, LS 1, ApplyPatch 1, Execute 1)* | 33.1 s |
| T1 log triage | gpt-6-luna, xhigh (reason "routine") | direct_only | yes | 3,664 | 10 | 9 (TodoWrite 5, Execute 4) | 74.2 s |

\*Counts are the tool-call blocks in the session file.

Token detail (from `tokenUsage`):

- T3: input 1,360; output 1,400; cache creation 12,260; cache read 52,046; thinking 742.
- T1: input 1,507; output 2,664; cache creation 13,810; cache read 115,889; thinking 1,040.

### What the app's "own AI engines" are (checked)

- **Auto = the Factory Router.** The session settings record `effectiveFactoryRouterModel`. Both runs
  routed to **GPT-6 Luna** (OpenAI) at xhigh effort, served by **Azure OpenAI** (`apiProviderLock:
  azure_openai`, `providerLock: openai`).
- The router also stores a fallback list: gpt-6.1-sol, claude-opus-5-5, glm-5.3, kimi-k3,
  deepseek-v4.1-flash-1017, minimax-m3.1-flash (same set in both runs, different order).
- Both runs ran in **direct mode**. GPT-6 Luna is not on the Script list, so the Script-mode claims
  (A, B) cannot be tested on Auto.
- The model picker lists these, with usage multipliers:

  | Group | Models |
  |---|---|
  | Top | Opus 5.5 1.6x; GPT-6.1 Sol 0.8x; Kimi K3 1.2x; GLM-5.3 0.56x |
  | Anthropic | Fable 5.1 4x; Opus 5.5 Fast Mode 3.2x; Sonnet 5.5 0.8x; Haiku 5.5 0.04x |
  | OpenAI | GPT-6 Astra 4x; GPT-6.1 Sol Ultra Fast 4.8x (greyed out); GPT-6 Luna 0.04x; GPT-6 Luna Fast Mode 0.08x; GPT-5.6 Terra 0.8x |
  | Google | Gemini 4 Argon 0.8x (50% off); Gemini 3.1 Pro 0.8x; Gemini 3.8 Flash 0.3x (50% off) |
  | xAI | Grok 4.7 0.8x |
  | Droid Core | Inkling 0.4x; Mistral Large 4 0.544x; Mistral Medium 3.5 0.6x; GLM-5.3-Flash 0.06x; Qwen3.8 Max 0.8x; Nemotron 3.5 Super 0.08x; Nemotron 3 Ultra 0.24x; DeepSeek V4.1 Flash 1017 0.12x; MiniMax M3.1 Flash 0.06x; Muse Spark 0.5x (two versions); Beam 1.0 0.52x |
  | Legacy | about 40 more, hidden by default |

### Cost compared with the Opus 5.5 pilot

| Task | App, Auto (Luna) | CLI, Opus 5.5 script | CLI, Opus 5.5 direct |
|---|---|---|---|
| T3 | 2,786 | 21,634 | 47,193 |
| T1 | 3,664 | 29,771 | 60,213 |

The app on Auto was about **8 to 17 times cheaper** in credits and passed both tasks. It was slower
(33 s and 74 s vs 16 to 38 s) and took more turns.

### Plan usage (Settings > Usage, viewed after all pilot and app runs)

- Standard usage: 5-hour **2%**, weekly **1%**, monthly **1%**.
- Extra usage balance: $0.00. When Standard usage runs out, the org setting switches sessions to a
  Droid Core model (the other choice, Extra Usage, is off).
- Managed computers: 0 of 20.0 h used.
- So the 4 pilot runs plus the 2 app runs (about 165,000 credits) used about 1% of the monthly
  allowance. This is a rough reading of the bars: the page shows whole percents only.

### Not checked

- Whether `factoryCredits` already include the per-model multiplier (Luna 0.04x, Opus 5.5 1.6x).
- Whether the router would pick a different model for a harder task or on another day.

Side note: two "New Session" clicks during setup made empty sessions (0 credits, no messages).

# Perf (spec section 7)

`bun perf/gate.ts` runs the benchmarks in `perf/bench.ts`, compares them with `perf/baseline.json` and the base-prompt
budget in `src/agent/budget.ts`, prints a Markdown report and exits 1 on a gated failure. CI runs it after `bun test`.

## Gated

| Check | Rule |
| --- | --- |
| First-keystroke p95 (in-process TUI) | at most `max(baseline x 3, baseline + 10 ms)`, never above 250 ms; a failure is re-measured once before it fails |
| First-keystroke p95 (pty, real process) | at most 250 ms (spec cap) |
| Base prompt | system chars, tools chars (direct and script mode) and context blocks at most `BASE_PROMPT_BUDGET` |

Everything else (turn preparation, tool lookup, exec first request, daemon ready, per-session memory, quit, first paint,
first prompt accepted) is measured and reported against its target but is not gated: those numbers depend on the machine.

## First-keystroke method

In-process (the gated number): `runTui` from `src/tui/app.ts` runs in the benchmark process with a fake TTY stdin and
stdout, an in-process session and a fake model server. A 150-line answer is put on screen first so redraws are not
trivial. Each sample is the time from `stdin.emit("data", <one key>)` to the redrawn frame being written to stdout; 300
samples after 20 warm-up keys; p95 by nearest rank. Pty: the real `rigwell` process under `Bun.spawn({ terminal })`, a key
written to the pty master, sample ends at the next output chunk (100 samples).

The in-process p95 is a fraction of a millisecond, so the +10 ms slack is what keeps CI quiet; a regression that matters
(a redraw that becomes O(history), a synchronous disk read per key) is far above it. Re-baseline on purpose with
`bun perf/gate.ts --update-baseline` and review the diff.

## Other commands

- `bun perf/bench.ts [--quick] [--only keystroke,lookup,turn,exec,daemon,pty] [--out file.json]` raw results as JSON.
- `bun perf/gate.ts --results file.json` gate saved results (used by `test/perf/gate.test.ts`).
- Per-session memory is the RSS delta of a daemon over 10 extra `initialize_session` connections (idle sessions, no turns).
- Not measured: "read only the newest part of session history" (no code path reads history on the hot path yet) and auth checks (there are none).

## Startup with many tools and many models

`bun perf/bench-startup.ts [--quick] [--json]` starts an in-process session with N MCP tools (spread over 5 fake stdio servers
from `test/fakes/fake-mcp-many.ts`) and M custom models in settings, for N = 0, 100, 500 and M = 0, 50, 200. It prints session
ready time, time until every server connected, time to the first model request, a later turn, first request size, and the
`list_tools` RPC. It is not gated; `test/perf/startup.test.ts` holds generous regression bounds (parallel connect, cached tool
lookup, end-to-end smoke).

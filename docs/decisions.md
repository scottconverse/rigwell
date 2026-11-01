# Phase 1 decisions

Choices made where the spec marks something [UNKNOWN], leaves it open, or says nothing. Where the spec
has a [DESIGN] default, Phase 1 uses it and it is not repeated here. Each entry: the choice, then why.

## Architecture and protocol

1. **Stack:** TypeScript on Bun 1.4, no runtime dependencies. Spec §2 first recommendation.
2. **Daemon and exec share one code path.** `rigwell exec` hosts the same connection and session code
   in-process over stdio. `rigwell daemon` serves it over a Unix socket (`$RIGWELL_HOME/daemon.sock`),
   many sessions in one process. Simplest way to meet "daemon + exec" without exec depending on a
   running daemon.
3. **One session per connection** (§10 open decision 2, default). Session-scoped requests carry no
   `sessionId`; every notification carries `params.sessionId` except `settings_updated` before the
   `initialize_session` response, where the id is not yet known to the client.
4. **Envelope:** `{jsonrpc, type, protocolVersion, id, method, params | result | error}`. Method prefix
   `rigwell.`. `protocolVersion` is `0.1.0`. `factoryApiVersion` dropped (§3.1.2 DESIGN).
5. **Working-state notification is named `agent_working_state_changed`** (§3 says rename).
6. **Methods built:** `initialize_session`, `load_session`, `add_user_message`, `interrupt_session`,
   `close_session`, `update_session_settings`, `list_tools`, `list_models`, `get_context_stats`.
   `compact_session`, `fork_session`, the MCP methods and `warmup_cache` answer `-32601` with "not in
   this build": they belong to later phases (compaction Phase 4, MCP Phase 5, cache Phase 3).
7. **Settings changeable mid-session:** only the fields §3.1.5 allows on `update_session_settings`
   (model, effort, interaction mode, autonomy). §10 open decision 1, default.
8. **Duplicate in-flight request id** answers `-32006 CONFLICT` (§3.1.3 DESIGN). A second
   `initialize_session` or `load_session` on one connection also answers `CONFLICT`.
9. **Client notifications are ignored**; the harness takes none in Phase 1.

## Agent loop

10. **No loop guards in Phase 1.** §4.2 guards are Phase 4 scope. A runaway model is bounded only by
    the user interrupting.
11. **Deltas are display only; `message_done` is the truth.** After a mid-stream retry the adapter
    restarts at block 0 and repeats deltas; the persisted message comes only from the final event.
    This is how "discard the partial message" (§4.2) is met without buffering the stream.
12. **One permission prompt per tool call**, not one per batch (§5.5.5 describes batch prompts). Simpler;
    batch prompts can come with the TUI.
13. **"Cancel" on a prompt ends the turn** with `permission_rejected`; later calls in that batch get a
    "not run" result. With `autoRejectPermissionRequests` the call is rejected and the model continues
    (§5.5.6).
14. **Prompt mode with no approver** ends the turn with `no_approver_available` and exits 1, telling the
    user to re-run with a higher `--auto` or `--skip-permissions-unsafe` (§5.5.6).
15. **`max_tokens`:** the model's `maxOutputTokens`, else 32,000 (the observed value, §6.4).
16. **Context blocks** sent: environment, session/git, todos. Project instructions (AGENTS.md) and skills
    are Phase 5, so those blocks are left out. Git status shows at most 50 entries; the listing at most
    100 entries.
17. **Encrypted OpenAI reasoning is dropped** from requests when the message's provider differs from the
    current model's provider (§4.6.2 DESIGN, applied per message).
18. **Prompt text is generated** from `spec/prompts.md` by `scripts/gen-prompts.ts` into
    `src/agent/prompt-text.generated.ts`, so it cannot drift from the spec.
19. **Default model:** `sessionDefaultSettings.model`, else the first valid custom model. No built-in
    models: there are no vendor keys in Phase 1.

## Tools

20. **Tools built:** Read, Execute, Grep, Glob, Edit, Create (the Phase 1 list). LS and Skill are not
    built, though the base prompt and the Read description mention LS; that text is the spec's and is
    kept as written. The Read error for a directory points to Glob instead.
21. **Tool gating:** with autonomy `off` and no skip, Edit and Create are not sent (§5.1 RUN: exec
    read-only sends no Edit/Create). With skip, Execute drops `riskLevel`/`riskReason` from its schema
    and the description lines that define them.
22. **Placeholders:** Read 2,000 lines by default and 2,000 characters per line; Execute output cap
    30,000 characters per stream (first 15,000 + last 15,000, with a cut marker); shell `bash`, else
    `/bin/sh`.
23. **Not in this build:** Execute `background: true` returns an error (background jobs are Phase 2);
    Read refuses images (no image path yet) and files over 50 MB.
24. **Execute env** adds `CI=1`, `GIT_PAGER=cat`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, so commands do
    not wait on a pager or prompt. Timeout and interrupt kill the whole process group.
25. **Grep and Glob use `rg`** with `--no-require-git`. Globs are matched in JS over `rg --files`,
    because rg's `-g` would re-include git-ignored files. `rg` must be on PATH.
26. **Edit** retries a LF `old_text` against a CRLF file and writes CRLF back. **Create with overwrite**
    needs a fresh read record, not only a present one.

## Permissions

27. **Allow-list entries need adjacent tokens.** The 100-character gap applies to deny and block
    entries only; otherwise `git commit -m status` would auto-allow through `git status` at Off.
28. **One-token deny entries** (`shutdown`, `mkfs`, `reboot`) match only at command position (after
    optional `sudo`, `env`, `nohup` or a path), so `grep reboot log` does not ask. Multi-token entries
    match anywhere in a segment.
28b. **A deny entry whose last token is a path** (`dd of=/dev`) also matches paths under it
    (`of=/dev/sda`); a bare `/` (as in `chmod -R 777 /`) stays exact. Without this, device writes passed.
29. **`rm-protected-target` is a structural check** of recursive `rm` targets, path-normalized. The
    `/tmp` exception needs every target under `/tmp/` with no `..`.
30. **Extra safeguard id `fork-bomb`**: the spec lists fork bombs in the deny table but has no id for
    them.
31. **Never auto-allowed:** a segment with an output redirect (other than `2>&1` or `/dev/null`) or a
    command substitution; a command made only of the ignorable `head/tail/grep/cat/echo` segments;
    anything with unbalanced quotes. Otherwise `echo x > f` would pass the ignore rule.
32. **`&` splits segments** (except in `2>&1` and `&>`).
33. **Not built:** the `powershell -Command` body parse and the `-EncodedCommand` rule. Such commands
    are never auto-allowed and still meet deny-list matching.
34. **Missing `riskLevel` is checked first**, before the lists.
35. **Spec mode:** a deny-list match is blocked (not asked); an allow-list match runs; anything else
    above `low` is blocked (§5.5.7 DESIGN). Spec files must resolve inside `<cwd>/.rigwell/specs/`.
36. **Unknown tools ask** with `alwaysLevel` null.

## Providers

37. **OpenAI adapter is the Responses API over HTTP SSE.** No WebSocket (§4.6.3 allows v1 without it).
    Chat Completions (`generic-chat-completion-api`) is not built: Phase 1 asks for one OpenAI adapter.
38. **Retries:** exec uses `non_interactive` (5 attempts, 2 s base, ×2.5). Jitter is added upward only.
    A 429 gets the same 5 attempts in exec (the spec gives 6 only for interactive). `retry-after-ms` wins
    over `retry-after`; both apply only to 429. `unavailable` is reported as `overloaded` in `llm_retry`,
    since the reason enum has no `unavailable`.
39. **Status mapping:** 500 is retried only when the body says overloaded, internal error or
    unavailable; other unexpected statuses are `unknown`, not retried. A user abort is a non-retryable
    error; the 600 s client timeout is a retryable `timeout`.
40. **Empty response** (no content blocks) is retried once, in the retry wrapper.
41. **Anthropic:** thinking blocks are replayed only when signed by Anthropic; `tool_result` blocks go
    first in a user message; empty text blocks are dropped. Cache breakpoints: last system block and
    newest user message only. The two context-block breakpoints (prompts.md §4) are Phase 3.
42. **OpenAI usage:** `inputTokens` = `input_tokens` minus cached tokens, to match Anthropic's meaning;
    `cacheReadTokens` = cached; `thinkingTokens` = reasoning tokens. Only reasoning items with
    `encrypted_content` are replayed. The `{effort:"none"}` exception is not built.
43. **Auth header:** `x-api-key` (Anthropic) or `Authorization: Bearer` (OpenAI) only when `apiKey` is
    set; `extraHeaders` can override, e.g. Azure's `api-key`.

## Storage and settings

44. **Home folder** `~/.rigwell`, overridable with `RIGWELL_HOME` (tests always set it). Project
    config in `<root>/.rigwell/`.
45. **Slug:** a `-` is prefixed only when the result does not already start with one, so `/home/a/b`
    becomes `-home-a-b`. Windows-style paths are handled as text on other platforms.
46. **OpenAI reasoning on disk:** the first item as `openaiReasoningId`, `openaiEncryptedContent`,
    `openaiReasoningSummary` (the spec's field names); further items in `openaiReasoningMore`.
47. **`seq` starts at 0** (the real files' context message has seq 0). Messages load in `seq` order; the
    `parentId` chain is written but not walked (no fork or compaction yet).
48. **`tool_result` on disk** always writes `is_error`. Unknown block and record types are skipped on load.
49. **Lock file:** a lock older than 10 s is stolen; waiting gives up after 30 s.
50. **Session lookup order:** the cwd's slug folder, then every folder under `sessions/`, then the root.
51. **Session settings `.bak`:** written only from a main file that parses, so a corrupt file never
    replaces a good backup.
52. **Settings merge:** objects deep-merge; arrays and scalars replace, command lists included.
53. **Project and folder config always load.** `trustedFolders` is read but not enforced in Phase 1:
    headless runs have no way to ask for trust. Add the gate with the TUI.
54. **Git root** is found by walking up for a `.git` entry (directory or file).
55. **Custom model ids** `custom:<displayName with dashes>-<index>`, where index is the position in
    `customModels` including invalid entries, so ids stay stable. The old `custom:<model>` form matches
    the first model with that name. `${VAR}` expands in `apiKey` and `extraHeaders`; `process.env` wins
    over `settings.env`; an unset variable invalidates the entry.
56. **Not built:** the SQLite session index (the spec makes it a cache; `listSessions` scans files),
    `fileEditToolProfile` (Create + Edit for every model), the keychain (keys come from settings or env).

## Phase 10: Local automations

57. **Folders:** `$RIGWELL_HOME/automations/<slug>/` and `<project>/.rigwell/automations/<slug>/`. The folder name is a slug of
    the name; the id is the UUID in `memory/state.json`. `state.json` also holds `createdAt`, `health` (`degraded`) and the
    pending `retry`. Extra frontmatter beyond the spec: `timezone` (IANA, default machine zone), `autonomy` (default `high`),
    `payloadRegex`, `maxRunsPerHour`. A webhook automation needs no `schedule`.
58. **Schedules:** presets, 5-field cron (ranges, steps, names, 7 = Sunday, day-of-month OR day-of-week) and
    `every <n><m|h|d>` intervals counted from `createdAt`. Natural language is not parsed. Zone offsets are re-read every 15
    minutes of scan time. A local time that does not exist (spring-forward gap) never matches; a repeated one (fall back) can
    match twice.
59. **Scheduler:** `tick()` is explicit and the clock is injected; the daemon calls it every 60 s. Due and catch-up are one
    rule: the first slot after `lastRunAt` (else `createdAt`) that is `<= now` runs once; `catchUp` is true when it is a minute
    or more late, `missedSlots` counts the others. Sleep = a gap over 150 s between ticks, then dispatch is held 150 s. Retries
    are due when `retry.at <= now` and count toward the same caps (2 dispatches per tick, 3 concurrent).
60. **Runs:** headless in-process connection (`canPrompt` false), autonomy from the automation (never skip-all). An unresolved
    model falls back to the default and records `modelFallback`; with no default the run fails `dispatch_exception`. The session
    closes as soon as the turn ends (no 15 s grace). `targetSessionId` loads that session and adds the prompt.
61. **Not built:** auto-pause after 10 days, `mcp_unavailable` flagging, `host_slept` reason, agent tools
    (`CreateAutomation` etc., `Loop`), the `/loop` slash command, natural-language schedules. Project automation folders are
    scanned only for `projectDirs` given to the service or used by `create_automation` with `projectDir` (not persisted).
62. **Webhook:** `POST /hooks/<id>` on `127.0.0.1`, default port 47821 (`settings.automations.webhookPort`, host via
    `webhookHost`). The listener exists only while some valid automation has `trigger: webhook`. Auth: `Authorization: Bearer
    <secret>` or `X-Rigwell-Signature: sha256=<hmac of body>`. Responses: 202 `{runId}`, 200 `{status: filtered|deduped}`,
    401, 404, 409 (paused or running), 413 (256 KB), 429 capped. Dedupe window 60 s. Deliveries go to `memory/deliveries.json`.
63. **Crons:** `$RIGWELL_HOME/crons/<scope>/<sessionId>/<id>.json`, with the prompt stored in the record. The "previous prompt
    still queued" check is `session.isRunning`. Methods are `rigwell.*` (listed in `src/automations/index.ts`), not `daemon.*`.

## Phase 5: Clients (SDK, WebSocket, TUI)

64. **SDK layout:** `src/sdk/` has `transport.ts` (spawned `exec` process, Unix socket, WebSocket), `client.ts` (JSON-RPC client with
    the spec 3.1.5 request timeouts), `session.ts` (`run`, `createSession`, `connectToDaemon`, `RigwellSession`) and `in-process.ts`
    (used by the TUI; not re-exported from the index so remote users do not load the harness). `send()` returns an async iterable of
    notifications that ends with `agent_turn_completed`; its `.done` promise gives `{reason, text, ...}`. A turn ends only on the
    `agent_turn_completed` whose `turnId` equals the message id the SDK sent. If the transport closes mid-turn the turn ends with a
    synthetic `error` and `agent_turn_completed {reason: "process_exit"}`.
65. **SDK defaults:** no permission handler, or one that throws, answers `{selectedOption: "cancel"}`; `ask_user` answers
    `{cancelled: true, answers: []}`; `pick_options` answers `{cancelled: true, selectedIds: []}` (spec 3.1.8). Spawned-process shutdown:
    end stdin, wait 2 s, SIGTERM, SIGKILL after 3 s more (spec 3.1.1). The SDK sends `sessionOriginHint: "sdk"` and `userMessageSource: "sdk"`.
66. **WebSocket:** the daemon also serves `ws://127.0.0.1:<port>/` (default 47822; `daemon.wsPort` in settings or `--ws-port`; `--no-ws`
    turns it off; a busy port logs a warning and the daemon runs without WebSocket). One WebSocket = one session through
    `createConnection`; one JSON-RPC message per text frame (no newline framing). Bound to 127.0.0.1 only.
67. **WebSocket auth:** a random 32-byte hex token per daemon start, required on the upgrade request as `?token=<t>` or
    `Authorization: Bearer <t>`; missing or wrong gets HTTP 401 with no upgrade (constant-time compare). The Host header must be
    loopback (403 otherwise, blocks DNS rebinding). The token, socket path, WS URL and pid are written to `$RIGWELL_HOME/daemon.json`
    with mode 0600 and removed on stop. The `Sec-WebSocket-Protocol` route was not used because browsers cannot set headers but can
    use the query string, and the SDK uses the query string too.
68. **TUI structure:** `reducer.ts` is pure (events in, `{state, effects}` out, time passed in events), `render.ts` is pure
    (state to lines plus cursor), `keys.ts` parses stdin bytes, `app.ts` is the only terminal and RPC I/O. No TUI library was added.
    It uses the alternate screen, raw mode and bracketed paste when stdout and stdin are TTYs; when piped it skips all of that, reads
    keys from stdin, waits for a running turn at EOF, and prints the final screen as plain text.
69. **Steer versus queue:** the harness has no mid-turn steering (a message sent during a turn runs after it). So the TUI keeps
    pending messages itself: Enter during a run adds a "steering" message, Ctrl+Enter a "queued" one; when the turn ends, steering
    messages go first, then queued ones, one turn at a time. This makes Ctrl+R/G/X real. After an Esc interrupt pending messages are
    kept and not sent. Alt+Enter also queues, for terminals that do not report Ctrl+Enter.
70. **Keys:** Ctrl+C clears the input; on empty input twice within 1.5 s it quits (spec says only "clear"). Ctrl+D on empty input
    quits. Tab cycles reasoning (off, low, medium, high) unless a menu is open. Shift+Tab toggles auto and spec. Ctrl+L cycles autonomy
    off, low, medium, high. Not built: Ctrl+V image paste, Ctrl+Shift+C, Alt+P plan view, Alt+arrows paging, Ctrl+J changelog (the
    last three are outside the 13.7 v1 cut). Transcript shows the newest lines that fit; there is no scrolling.
71. **Commands:** `/droids` from the spec table is `/agents` here (the product name is not used). `/mcp`, `/hooks`, `/skills`,
    `/commands`, `/agents` show "not available in this build yet" until their phases. `/compress`, `/fork` call `compact_session` and
    `fork_session` and show the harness error while those do not exist; `/rename` calls `rename_session` (not in the spec MVP list)
    with the same fallback. `/rewind-conversation` and double Esc on empty input say rewind is not available (the harness cannot
    truncate a session). `/cost` shows token counts only: there is no pricing data for local models. `/context` shows the provider
    meter from `get_context_stats`, and the category list and bar only if the result carries `categories` (the harness does not yet).
72. **Context percent:** last call's `inputTokens + cacheReadTokens` over the `limit` from `get_context_stats`, refreshed after
    every turn; `<1%` for tiny values and `n/a` until the first stats call returns.
73. **Panels:** permission, batch ("Approve N operations", grouped), exit-spec ("Specification for approval", "Will save to"),
    ask_user (one question at a time, Space toggles multi-select, Esc cancels and interrupts) and pick_options render from the request
    params. Field names for the exit-spec plan (`plan`, `specContent` or `content`) and path (`filePath` or `path`) are guesses until the
    spec-mode phase defines them. Denial comments (`[Comment]`) are not built.

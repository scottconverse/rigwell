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
   this build": they belong to later phases (compaction Phase 4, MCP Phase 5, cache Phase 3). (Superseded by #118 (warmup_cache), #131 (compact_session), #148 (MCP methods), #151 (fork_session) and #171 (rewind_session).)
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
12. **Batch permission prompts** (replaces the Phase 1 "one prompt per call", §5.5.5): when a model answer holds two or
    more calls that each need approval, the client gets one `request_permission` with every call in `toolUses` and
    the options "Yes, allow all" (`proceed_once`) and "No, cancel all" (`cancel`). Cancel rejects every call that asked
    and stops the turn. A single asking call keeps its own options. Calls with their own option lists (MCP tools,
    ExitSpecMode) and sessions with hooks (a hook may rewrite a call) are prompted one by one.
13. **"Cancel" on a prompt ends the turn** with `permission_rejected`; later calls in that batch get a
    "not run" result. With `autoRejectPermissionRequests` the call is rejected and the model continues
    (§5.5.6).
14. **Prompt mode with no approver** ends the turn with `no_approver_available` and exits 1, telling the
    user to re-run with a higher `--auto` or `--skip-permissions-unsafe` (§5.5.6).
15. **`max_tokens`:** the model's `maxOutputTokens`, else 32,000 (the observed value, §6.4).
16. **Context blocks** sent: environment, session/git, todos. Project instructions (AGENTS.md) and skills
    are Phase 5, so those blocks are left out. Git status shows at most 50 entries; the listing at most
    100 entries. (Superseded by #146: project instructions and skills are context blocks now.)
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
    Read refuses images (no image path yet) and files over 50 MB. (Superseded by #82 for background Execute and #205 for images; Read still refuses files over 50 MB.)
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
    `parentId` chain is written but not walked (no fork or compaction yet). (Superseded by #131, #151 and #171 for compaction, fork and rewind; the parentId chain is still not walked.)
48. **`tool_result` on disk** always writes `is_error`. Unknown block and record types are skipped on load.
49. **Lock file:** a lock older than 10 s is stolen; waiting gives up after 30 s.
50. **Session lookup order:** the cwd's slug folder, then every folder under `sessions/`, then the root.
51. **Session settings `.bak`:** written only from a main file that parses, so a corrupt file never
    replaces a good backup.
52. **Settings merge:** objects deep-merge; arrays and scalars replace, command lists included.
53. **Project and folder config always load.** `trustedFolders` is read but not enforced in Phase 1:
    headless runs have no way to ask for trust. Add the gate with the TUI. (Superseded by #217.)
54. **Git root** is found by walking up for a `.git` entry (directory or file).
55. **Custom model ids** `custom:<displayName with dashes>-<index>`, where index is the position in
    `customModels` including invalid entries, so ids stay stable. The old `custom:<model>` form matches
    the first model with that name. `${VAR}` expands in `apiKey` and `extraHeaders`; `process.env` wins
    over `settings.env`; an unset variable invalidates the entry.
56. **Not built:** the SQLite session index (the spec makes it a cache; `listSessions` scans files),
    `fileEditToolProfile` (Create + Edit for every model), the keychain (keys come from settings or env). (Superseded by #215 (fileEditToolProfile), #227 (session index) and #228 (credential store).)

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
    scanned only for `projectDirs` given to the service or used by `create_automation` with `projectDir` (not persisted). (Superseded by #181 (/loop), #188 (auto-pause), #189 (host_slept), #190 (mcp_unavailable), #191 (natural-language schedules), #192 (agent tools) and #193 (project registry).)
62. **Webhook:** `POST /hooks/<id>` on `127.0.0.1`, default port 47821 (`settings.automations.webhookPort`, host via
    `webhookHost`). The listener exists only while some valid automation has `trigger: webhook`. Auth: `Authorization: Bearer
    <secret>` or `X-Rigwell-Signature: sha256=<hmac of body>`. Responses: 202 `{runId}`, 200 `{status: filtered|deduped}`,
    401, 404, 409 (paused or running), 413 (256 KB), 429 capped. Dedupe window 60 s. Deliveries go to `memory/deliveries.json`.
63. **Crons:** `$RIGWELL_HOME/crons/<scope>/<sessionId>/<id>.json`, with the prompt stored in the record. The "previous prompt
    still queued" check is `session.isRunning`. Methods are `rigwell.*` (listed in `src/automations/index.ts`), not `daemon.*`.
## Phase 9: Git worktrees

64. **initialize_session param** `worktree: {enabled: true, branch?, branchMode?: "copy"|"existing", baseRef?,
    lifecycle?: "ephemeral"|"persistent", setupProfile?, prompt?}` (`worktree: true` is shorthand). `prompt`
    names the generated branch because the first prompt is not known at init. `runInWorktree: true` in
    settings makes it the default when the param is absent. The result adds `worktree: {path, branch,
    baseRef, repoRoot, lifecycle, setupProfileId?, adopted, cwd, setup?}`; session settings store the same
    (without cwd/setup) under `worktree`. The session cwd (and transcript cwd) is the worktree path, plus
    the request cwd's relative folder when it was a repo subfolder. A cwd already inside a managed
    worktree is adopted.
65. **Root and names:** default root `<rigwell home>/worktrees`; `worktreeDirectory` must be absolute.
    Layout `<root>/<last 8 of session id>/<repo folder>`. Branch prefix `rigwell/`; slug = up to 5 words,
    padded to 3 with `work`, `task`, `tree`; whole name at most 32 chars; `-2`.. on a clash (up to 100).
    No prompt: `<current branch>-wt`. Created with `worktree add -b <branch> --no-track <path> <base>`.
66. **State lives in the worktree's git dir:** `rigwell-worktree.json` (session, repo, branch, base, lifecycle,
    profile, createdAt, lastUsedAt, pinned, reserved) and `rigwell-setup-receipt.json` (head, time,
    lifecycle, sha1 fingerprints of untracked files). Listing scans the root; there is no separate registry.
    "Uncommitted user work" = `status` entries minus untracked files whose path and content still match
    the receipt (setup output). Without a receipt every untracked file counts as user work.
67. **Secret stripping (§18.3)** removes env names that are product-prefixed (`RIGWELL_`), contain TOKEN,
    SECRET, PASSWORD/PASSWD, CREDENTIAL, PRIVATE_KEY, API_KEY/APIKEY or ACCESS_KEY, are database/queue URLs
    (`DATABASE_URL`, `*REDIS*_URL`...), belong to cloud/provider families (AWS_, AZURE_, GCP_, GCLOUD_,
    GOOGLE_APPLICATION_, GITHUB_, GH_, GITLAB_, NPM_CONFIG_, ANTHROPIC_, OPENAI_, GEMINI_, MISTRAL_, GROQ_,
    OPENROUTER_, HF_, HUGGINGFACE_), or are SSH_AUTH_SOCK/SSH_AGENT_PID/GPG_AGENT_INFO. Matching is by
    name; values are never inspected. Scripts run with `bash -c` (or `sh`), PATH taken from a login shell
    (only PATH is taken), `REPO_ROOT_PATH` added, setup timeout 20 min, cleanup 5 min, output tail capped
    at 4 KB with control characters removed. Only bash/sh is built (no PowerShell).
68. **Profiles** are YAML (`Bun.YAML`), id = file name. Repository: `<repo>/.rigwell/worktree-setups/*.yaml`,
    runs only when the repo root is in `trustedFolders`. Local: `<rigwell home>/worktree-setups/
    <sha256(repoRoot)>/*.yaml`, no trust check; local wins on an id clash. A profile that cannot run
    (missing, untrusted) is reported in `worktree.setup.skipped`; the worktree is still created.
    `index.yaml` / `lastUsedProfileId` and "deleted profiles keep name + cleanup script" are not built. (Superseded by #187.)
    Setup runs inside initialize_session after the session exists, emitting `setup_step_progress`
    notifications `{kind: "setup_script", text}`; the profile's `initialPrompt` is returned in
    `worktree.setup.initialPrompt` for the client to send (the daemon does not send it).
69. **Limits:** 4 concurrent creations (2 per repo), 2 removals, FIFO; auto-delete one pass at a time;
    30 min recent-use guard (`lastUsedAt` is set at creation and by `keep`).
70. **Auto-delete** runs before each creation. Candidates: ephemeral, over `worktreeAutoDeleteLimit`
    (default 15), LRU first. Skipped: pinned, reserved, in use by a live session in this process, used within
    30 min, uncommitted work, commits found on no other branch and no remote. The PR rule is skipped
    (create_pr is not built).
71. **Protocol methods** (`rigwell.` prefix, no session needed unless noted): `list_managed_worktrees
    {repoRoot?}`, `get_worktree_status {worktreePath?}` (default: the session cwd), `inspect_worktree_deletion
    {worktreePath}`, `cleanup_worktree {worktreePath, deleteLocalBranch?, deleteRemoteBranch?, force?}`,
    `list_git_branches`, `checkout_git_branch {branch, resolve?: "stash"|"commit", message?}` (dirty tree
    returns `{ok:false, status:"needs_resolution", changedFiles}`), `get_git_branch_divergence {against?}`,
    `git_commit {message}` (stages all), `git_push` (to the first remote, setting upstream). The last five
    act on the session cwd, or `worktreePath`. They replace the spec's `daemon.*` names; errors carry
    `data.code` (dirty, in_use, branch_occupied, root_branch...).
72. **Removal** refuses reserved, in-use (this process) and dirty worktrees unless `force`; runs the profile
    cleanup script (trusted or local only); uses `--force` only when the tree has changes (setup output or
    forced user work); keeps the branch unless asked. When session start fails after creation the worktree
    and its new branch are removed.
73. **Not built:** fetch from origin (`pullFromOrigin`), rename of a generated branch after the title,
    HEAD watching and `branch_changed`, the 5-minute housekeeping timer and archive-time removal (needs
    session archiving), `daemon.worktree.removed` broadcast, trust marking of the new folder, the
    Windows PowerShell runner, PR status and `create_pr`. (Superseded by #182 to #186; the PowerShell runner, PR status and `create_pr` are still not built.)

## Phase 2: Script mode

74. **Sandbox engine:** QuickJS compiled to WebAssembly (`quickjs-emscripten`, pinned 0.31.0) inside a separate child process
    (`src/script/runner.ts`, spawned with `bun`, nearly empty environment). The spec says not to rely on `node:vm`; QuickJS has no
    host objects at all (no process, require, fetch, timers, module loader), so a constructor-chain or `import()` escape finds nothing.
    The child gives a kill switch (SIGKILL on stop or time limit); the interrupt handler stops endless synchronous loops
    (`sliceMs`), a memory limit and stack limit stop blow-ups. Host functions are passed to a bootstrap function as arguments and
    never become globals. This is spec option 3 (QuickJS in WASM) plus process isolation; the Rust+V8 option was not built.
75. **Protocol to the child:** NDJSON on stdin/stdout. Every tool call, `results.search` and `results.get` is a message to the
    parent; the parent runs the real tool through the session (same `decide`/`askPermission` path as a direct call).
76. **Names and binding:** tools are bound under their Phase 1 names (`tools.Read`, `tools.Edit`, ...). Only tools the session really
    has are bound; the Script description drops the signatures (and the "MORE TOOLS" paragraph) of LS, Skill, ToolSearch and
    load_tools while those tools do not exist. `{{SCRIPT_EXTRA_BINDINGS}}` is empty. `Task` is not callable (no subagents yet). (Superseded by #110 (ToolSearch, load_tools), #145 (Skill, Task) and #202 (LS): the signatures are dropped only while a tool is missing.)
77. **Structured results (S1):** Read, Grep, Glob, Edit, Create results are parsed from the direct tool's text (`src/script/bindings.ts`);
    Execute returns `ToolOutput.data` (new optional field) so a non-zero exit resolves with `{exitCode,...}` instead of rejecting.
    A refused or failed call rejects with an Error; refusals have `name === "PermissionDenied"`.
78. **Limits:** 128 calls in flight (the rest queue), 5 MiB per result, 1,024 output events, 5 MiB output, 64 KiB printed (head and
    tail kept), 32 KiB per printed value, 1 MiB of input blocks. Sizes of the printed caps count characters, not bytes. Images are
    not shown (a placeholder line is printed). Foreground window 5 min; whole program 2 h; one synchronous slice 120 s. All three
    are overridable with `settings.scriptLimits` {foregroundMs,totalMs,sliceMs,memoryBytes}.
79. **Result log and output log:** `$RIGWELL_HOME/artifacts/scripts/<sessionId>/results.jsonl` holds every inner result except plain
    Read (also failed calls, as strings). `results.search` ranks by term hits (all terms must occur in tool, input or result);
    `results.get(job_id, call)` returns the stored value. `<toolUseId>.log` per run is the full printed output plus a line per call;
    it is the `log_ref` in the result. The outer result `content` is the JSON result shape (no array footer).
80. **Permissions:** the outer `Script` and `script_job` calls are allowed by the gate; each inner call is gated alone, with one
    prompt each when needed. "No, cancel" or no approver during a foreground Script stops the turn like a direct call; in a
    background Script it only throws PermissionDenied into the program. Hooks are not run for inner calls (Phase 5).
81. **Transcript and notifications:** inner calls are `user_only` messages `repl-tool-call:<runId>-<n>` and `repl-tool-result:<runId>-<n>`;
    notifications use `toolUseId` `<runId>-<n>` and `scriptExecution` on the `tool_call`.
82. **Jobs and wake:** `src/jobs/manager.ts`. Ids: `scr_<12 hex>` for Scripts, `job_<12 hex>` for Execute. A job counts as background
    once detached (`//@background`, the 5 min window passing, or Execute `background:true`). When a detached job finishes and its
    result was not read (script_job wait/status/stop marks it read), the session appends an `llm_only` user message
    `<system-reminder>...` and runs a turn (id `wake-<uuid>`). If a turn is running, the wake runs right after it. Jobs still running
    at `close_session` are stopped without a wake. Background Execute has no default timeout. `rigwell exec "prompt"` waits for
    background work and its wake turns before exiting.
83. **script_job** is shipped (not WaitForScript). Wait default and cap 300,000 ms; `stop` waits for the job to end.
84. **Wait guard (spec 4.2):** a batch made only of `script_job wait` on one job that is still running counts; at 24 the turn ends
    with the prompts 7.3 texts (user text as a `create_message` notification, transcript text as an `llm_only` message). No nudge
    and the Script keeps running. Only this guard is built; the other loop guards belong to a later phase.
85. **Tool mode:** `settings.scriptToolModels` (custom model id or API model name) puts a model on script_only; the session override
    is `toolExecutionMode` at `initialize_session` (kept in the session settings as `toolExecutionModeOverride`). script_only sends
    Script and script_job and adds the system_script block; direct_only sends the core tools plus Script and script_job. The effective
    mode is reported in `settingsSnapshot` and the context block. When `update_session_settings` changes the model and the mode
    changes with it, a `llm_only` notice is appended before the next user message.

## Phase 5: Hooks, MCP, skills, subagents, instruction files

Standalone modules (src/hooks, src/mcp, src/skills, src/subagents, src/instructions, shared src/config); the lead wires
them into the loop. Each index.ts starts with an "Integration" comment.

86. **Config folders.** `src/config/levels.ts` resolves hooks.json / mcp.json locations: folder levels (nearer first), project
    `<root>/.rigwell`, user `$RIGWELL_HOME`; "no project" when the root is or contains home. Hooks: `hooks.json` (legacy
    `hooks/hooks.json`) replaces the settings `hooks` key per event within a folder; levels concatenate, highest priority
    first. `trustProject: false` skips project and folder hooks (untrusted folder). Env vars given to hooks:
    `RIGWELL_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, plus `CLAUDE_ENV_FILE`/`RIGWELL_ENV_FILE` on SessionStart.
87. **Hook outcomes.** Exit 3 aborts, `continue:false` stops, then deny/exit 2 (config order), then allow, then ask. A legacy
    `decision: block|approve` is treated as deny/allow in PreToolUse. `updatedInput` from several hooks is merged in config
    order; `rerunChecks` is true unless the decision is allow. Stop hook: `stop_hook_active` is tracked by `HookRunner`
    (true after a continuation) with no hard cap on continuations (spec leaves the cap for Scott to decide).
    SessionStart's 60 s wait is the caller's (pass an AbortSignal). Plugin env and sandbox wrapping are not built.
88. **MCP.** OAuth is not built (spec marks it later); a 401/403 on an http server fails with a message and `headers` can carry
    a token. `mcp.json` format `{"mcpServers": {name: {type?, command, args, env | url, headers, disabled}}}` (a bare map also
    loads); add_mcp_server writes the user file only. Protocol version `2025-06-18`. A server that drops 6 times is
    status `failed` with a "suppressed" error and contributes no tools; drops before that reconnect after 1 s.
    Model-facing tool name `server__tool` (server name sanitized to `[A-Za-z0-9_-]`); Script binding `server.tool`.
89. **Skills.** Locations: project `<root>/.rigwell|.agents|.agent/skills/<name>/SKILL.md` (also `skill.mdx`), personal
    `$RIGWELL_HOME/skills`, `~/.agents/skills`, `~/.agent/skills`, dynamic (on touched paths), built-in. Zero built-in
    skills ship (content needs approval); the mechanism takes injected built-ins. No parse cache (files are small). The
    "additional skills" reminder text is `<skills_added>...</skills_added>` (own wording). Skill result =
    one-line "now active" note + `<skill name filePath>` body; `args` go on an "Arguments:" line inside the tag.
90. **Custom agents.** Folder `agents/` (`$RIGWELL_HOME/agents`, `<root>/.rigwell/agents`); `mcpServers` is parsed and passed
    through in the child options. Project agents shadow personal ones. Task core limits: depth 1, 5 per root, 10 per
    process, clamped 25/100, in `TaskLimits` (one per process). Read-only agents (tools only Read/LS/Grep/Glob/Skill) are
    capped at low autonomy. The child prompt is exactly the `prompt`; the agent body is passed as `agentSystemPrompt`.
91. **Instruction files.** One file per folder (first of CLAUDE.md, Claude.md, AGENTS.md, Agents.md, agents.md); the
    folders `D`, `D/.rigwell`, `D/.agents`, `D/.agent` are each checked. Symlink rule "inside its own folder" is
    implemented as "inside the project boundary" (repo root, or cwd outside a repo or when home is inside the repo root).
    Skipped files appear in the block as `not loaded: <reason>`. Truncated files end with a one-line note.

## Phase 5: Clients (SDK, WebSocket, TUI)

92. **SDK layout:** `src/sdk/` has `transport.ts` (spawned `exec` process, Unix socket, WebSocket), `client.ts` (JSON-RPC client with
    the spec 3.1.5 request timeouts), `session.ts` (`run`, `createSession`, `connectToDaemon`, `RigwellSession`) and `in-process.ts`
    (used by the TUI; not re-exported from the index so remote users do not load the harness). `send()` returns an async iterable of
    notifications that ends with `agent_turn_completed`; its `.done` promise gives `{reason, text, ...}`. A turn ends only on the
    `agent_turn_completed` whose `turnId` equals the message id the SDK sent. If the transport closes mid-turn the turn ends with a
    synthetic `error` and `agent_turn_completed {reason: "process_exit"}`.
93. **SDK defaults:** no permission handler, or one that throws, answers `{selectedOption: "cancel"}`; `ask_user` answers
    `{cancelled: true, answers: []}`; `pick_options` answers `{cancelled: true, selectedIds: []}` (spec 3.1.8). Spawned-process shutdown:
    end stdin, wait 2 s, SIGTERM, SIGKILL after 3 s more (spec 3.1.1). The SDK sends `sessionOriginHint: "sdk"` and `userMessageSource: "sdk"`.
94. **WebSocket:** the daemon also serves `ws://127.0.0.1:<port>/` (default 47822; `daemon.wsPort` in settings or `--ws-port`; `--no-ws`
    turns it off; a busy port logs a warning and the daemon runs without WebSocket). One WebSocket = one session through
    `createConnection`; one JSON-RPC message per text frame (no newline framing). Bound to 127.0.0.1 only.
95. **WebSocket auth:** a random 32-byte hex token per daemon start, required on the upgrade request as `?token=<t>` or
    `Authorization: Bearer <t>`; missing or wrong gets HTTP 401 with no upgrade (constant-time compare). The Host header must be
    loopback (403 otherwise, blocks DNS rebinding). The token, socket path, WS URL and pid are written to `$RIGWELL_HOME/daemon.json`
    with mode 0600 and removed on stop. The `Sec-WebSocket-Protocol` route was not used because browsers cannot set headers but can
    use the query string, and the SDK uses the query string too.
96. **TUI structure:** `reducer.ts` is pure (events in, `{state, effects}` out, time passed in events), `render.ts` is pure
    (state to lines plus cursor), `keys.ts` parses stdin bytes, `app.ts` is the only terminal and RPC I/O. No TUI library was added.
    It uses the alternate screen, raw mode and bracketed paste when stdout and stdin are TTYs; when piped it skips all of that, reads
    keys from stdin, waits for a running turn at EOF, and prints the final screen as plain text.
97. **Steer versus queue:** the harness has no mid-turn steering (a message sent during a turn runs after it). So the TUI keeps
    pending messages itself: Enter during a run adds a "steering" message, Ctrl+Enter a "queued" one; when the turn ends, steering
    messages go first, then queued ones, one turn at a time. This makes Ctrl+R/G/X real. After an Esc interrupt pending messages are
    kept and not sent. Alt+Enter also queues, for terminals that do not report Ctrl+Enter. (Superseded by #178: steering is `queuePlacement: "end_of_loop"`.)
98. **Keys:** Ctrl+C clears the input; on empty input twice within 1.5 s it quits (spec says only "clear"). Ctrl+D on empty input
    quits. Tab cycles reasoning (off, low, medium, high) unless a menu is open. Shift+Tab toggles auto and spec. Ctrl+L cycles autonomy
    off, low, medium, high. Not built: Ctrl+V image paste, Ctrl+Shift+C, Alt+P plan view, Alt+arrows paging, Ctrl+J changelog (the
    last three are outside the 13.7 v1 cut). Transcript shows the newest lines that fit; there is no scrolling. (Superseded by #180 (paging and scrolling), #237 (Ctrl+V) and #238 (Ctrl+Shift+C); Alt+P and Ctrl+J are still not built.)
99. **Commands:** `/droids` from the spec table is `/agents` here (the product name is not used). `/mcp`, `/hooks`, `/skills`,
    `/commands`, `/agents` show "not available in this build yet" until their phases. `/compress`, `/fork` call `compact_session` and
    `fork_session` and show the harness error while those do not exist; `/rename` calls `rename_session` (not in the spec MVP list)
    with the same fallback. `/rewind-conversation` and double Esc on empty input say rewind is not available (the harness cannot
    truncate a session). `/cost` shows token counts only: there is no pricing data for local models. `/context` shows the provider
    meter from `get_context_stats`, and the category list and bar only if the result carries `categories` (the harness does not yet). (Superseded by #174 (config views), #151 (/context categories), #179 (rewind) and #181 (other commands).)
100. **Context percent:** last call's `inputTokens + cacheReadTokens` over the `limit` from `get_context_stats`, refreshed after
    every turn; `<1%` for tiny values and `n/a` until the first stats call returns.
101. **Panels:** permission, batch ("Approve N operations", grouped), exit-spec ("Specification for approval", "Will save to"),
    ask_user (one question at a time, Space toggles multi-select, Esc cancels and interrupts) and pick_options render from the request
    params. Field names for the exit-spec plan (`plan`, `specContent` or `content`) and path (`filePath` or `path`) are guesses until the
    spec-mode phase defines them. Denial comments (`[Comment]`) are not built. (Superseded by #150 for the exit-spec field names, #240 for denial comments and the spec comment box, and #241 for free-text answers.)

## Phase 6: Eval loop
102. **Surface:** `rigwell eval run|report|tasks` lives in `src/eval/` (one dispatch line in `src/cli/main.ts`). Trials spawn
    `rigwell exec --input-format stream-jsonrpc` and read only wire notifications. Permission requests are declined.
103. **Requests** are counted as `session_token_usage_changed` events that change the totals (the turn-closing event repeats the
    previous totals). Tokens come from `agent_turn_completed.cumulativeTokenUsage`. Cost uses a per-model price table in the eval
    config (USD per Mtok); unpriced models get no cost deltas.
104. **Store and build id:** `$RIGWELL_HOME/eval/runs/<buildId>/<timestamp>.json`; buildId is the short commit sha of the checkout
    or `--build`. The report compares the latest run in the window to the latest run of the most recent earlier, different build.
105. **Regression thresholds:** any pass-rate drop; mean cost up over 20%; mean time up over 25%. Cost and time deltas prefer the set
    of tasks that passed every trial in both builds (spec section 8 methodology).
106. **Proposals as variants:** a variant is `settings` (passed as `--settings`) plus optional `toolExecutionMode`. The profile fields
    `promptVariant` and `toolDescriptionOverrides` do not exist in the session yet; when a later phase reads them from settings,
    a variant can carry them with no change here. Ship rule: all families hold, else per-model option, else do not ship. (Superseded by #215: `promptVariant` and `toolDescriptionOverrides` are read from the model profile.)
107. **Failure clusters:** same failKind, turn reason and normalized grader line, on at least 2 tasks and 2 models.

## Phase 3: Cache + budget

108. **Request builder** (`src/agent/request.ts`) owns request assembly: `[system][tools][history]`, the `user_only` filter, the
    provider-change reasoning strip, and the cache markers. The builder also registers each main-chain request with the cache monitor.
    A stored `is_error: false` on a tool result is dropped when the request is built, because the in-memory form has no field and a
    resumed session must send the same bytes as before it was saved (found by the persistence test).
109. **Breakpoints** (prompts.md section 4): four 1-hour markers in all: last system block and newest user message (set in the Anthropic
    adapter), plus the `<skills>` block and the `<todos>` block of the context message. Without a skills block the marker moves to the last
    block before `<session>`. Markers are a request-time `cache: true` flag on copies of the blocks (`TextBlock.cache`, never stored).
110. **Tools array**: it is computed from (mode, autonomy, skip-permissions) only. Deferred loads never touch it. In `direct_only` it holds
    the core tools, `load_tools`, `call_tool`, `Script`, `script_job` (the two new tools are always present so a later MCP connect needs no
    array change); in `script_only` it is `Script` and `script_job`. Changing autonomy across the read-only line (Edit and Create appear)
    or the model/mode does change the array; the monitor logs that with a cause ("autonomy changed (tool list)", "model changed"). Sending
    Edit and Create at every autonomy level would avoid that break but changes the Phase 1 tool list, so it is listed as a proposal.
111. **Deferred tools** (`src/agent/deferred.ts`): `Session.registerDeferredTool(tool)` / `unregisterDeferredTool(name)` (MCP will use them).
    Names are announced in an `llm_only` reminder (`deferred-<uuid>` message) before the next user message; changes later are delta
    reminders ("now available" / "no longer available"). Reminders produced while tools run ride as text blocks in the same user message as
    the tool results (no extra consecutive user message). `load_tools` text is PROMPT_TEXT; `call_tool` has no text in prompts.md, so a short
    description was written in code. A loaded tool is announced once with its signature. `ToolSearch` (keyword match over name and
    description, all words required, or `select:a,b`; loads up to `limit`, default 5, `more` counts the rest) exists only as a Script binding.
112. **Script bindings for deferred tools**: the sandbox `tools` object is now a Proxy. Names in the static list work as before; any other
    name is forwarded to the host, which accepts it only for a loaded deferred tool (`tools.server.tool` forwards `server__tool`).
    This is what lets a tool loaded by `tools.ToolSearch` be called in the same Script.
113. **Permissions for deferred tools**: `call_tool` and a Script call to a loaded tool are judged by the target tool: category `read`
    is allowed, anything else asks (no "always" option; spec 5.5.4 says MCP tools ask). `load_tools` and `ToolSearch` are allowed.
114. **Persistence**: `<id>.settings.json` gains `loadedDeferredToolNames` and `announcedDeferredToolNames`. `load_session` restores both,
    so a loaded tool stays loaded and a tool that registers later is callable at once. Phase 4 copies the loaded names into
    `compaction_state`.
115. **Cache monitor** (`src/agent/cache-monitor.ts`): per session, compares each request with the previous one block by block (system,
    each tool, each message block; cache markers ignored). A miss logs the first divergent block and a cause (known causes from the
    session, else inferred). Numbers: strict-append share over comparable requests (the first request has no predecessor), cache-read
    share token weighted and median, last 20 divergences. `get_context_stats` returns them under `cache`.
116. **get_context_stats** adds `breakdown` (estimated tokens, chars/4, per category: systemPrompt, tools, mcpTools, userInfo, agentsMd,
    customAgents, skills, messages) and `breakdownAccuracy`. `used` stays exact when a model call has happened. Deferred reminders count
    as mcpTools; `<environment>`, `<session>`, `<todos>` as userInfo; `<project_instructions>` as agentsMd; `<skills>` as skills.
117. **Budget** (`src/agent/budget.ts`, `test/agent/budget.test.ts`): measured at autonomy high, empty temp dir: direct system 5,102 chars,
    tools 18,077; script system 5,360, tools 7,863; context blocks 533. Budgets are those plus about 10 percent (direct 5,620 / 19,900,
    script 5,900 / 8,650, context 1,000). A second test fails if a budget is more than 15 percent above the measured size.
118. **warmup_cache**: builds the current prefix request, `max_tokens` 16; when history ends with an assistant message it adds a throwaway
    user message and puts a breakpoint on the last history block, so the next real request finds the prefix. Not part of the monitored
    chain, not stored; its usage is added to the session totals. Failures are logged, the method still returns `{}`. A running turn
    makes it a no-op.
119. **Fake servers** can simulate prefix caching (`startFakeAnthropic(script, { simulateCache: true })`, same for OpenAI): Anthropic
    reads the longest earlier breakpoint that is a prefix and within 20 blocks of one of its own breakpoints; OpenAI reads the common
    prefix once it is 1,024 tokens or more. Tokens are chars/4. Off by default.

## Phase 4: Guards + compaction

120. **Guard config** (`src/agent/guards.ts`): settings keys `llmRequestTimeout` (ms, default 600,000) and `loopGuards`
    {streamIdleTimeoutMs, hardResponseLimitMs, emptyTurnStop 3, repeatNudgeAt 3, repeatStopAt 6, cycleMinRepeats 8, cycleMinChars 1200,
    minCallsBetweenCompactions 2}. Idle limit: `loopGuards.streamIdleTimeoutMs`, else 240,000 when the model's baseUrl host is
    `api.anthropic.com` (vendor-hosted), else `llmRequestTimeout`. The hard response limit is `loopGuards.hardResponseLimitMs`, else
    `llmRequestTimeout`. A response header `x-response-time-limit-ms` sets the limit for that one response (spec says "a header"; the name is
    Rigwell's choice).
121. **Silent stream and hard limit** (`src/adapters/sse.ts`, `retry.ts`): the idle timer starts with the request and restarts on every received
    chunk (SSE comment pings count as bytes). Both cuts are retryable `timeout` errors tagged `cause: idle | hard_limit`, so `llm_retry`
    carries reason `timeout`. Hard limit: a cut is retried once (2 attempts); the second cut is not; a first cut that came later than
    limit + 60 s is not retried either.
122. **Mid-stream break**: unchanged from Phase 1 (retryable network error); the session now clears its partial-stream state on retry, and only
    `message_done` content is stored. Retries reuse the same model, provider, base URL and request, so they hit the cache holder. There is no
    provider rotation in this build.
123. **Empty turns**: an answer with no text and no tool call (empty or thinking only) is retried once by the retry layer (`passEmpty`, spec
    4.6.9), then reaches the loop guard: a user message `continue` after the 1st and 2nd, stop at the 3rd (texts from prompts.md 7.1). Stop and
    repeat-stop are "completed" turns with a `create_message` notice, like the Script-wait stop. The throwaway `{}` answer is still stored.
124. **Repeated calls**: a batch is its list of (tool name, canonical arguments) plus the results, with job/Script ids, UUIDs and `durationMs`
    normalized away. Consecutive equal batches count; new results reset the count (polling is allowed). Nudge text is appended to the tool
    results message exactly when the count reaches 3; at 6 the turn stops (prompts.md 7.2). Batches containing `script_job wait` skip this guard
    (they have the 24-wait guard).
125. **Output cycles**: while streaming, every 400 new characters the tail is checked (KMP smallest period over the last 1,200, 2,400, 4,800
    or 9,600 characters); a cycle is a period p with window / p at least 8. The stream is cut, nothing of it is stored, the turn ends with an
    `error` notification "the same N-character block repeated M times in the model output" and an `llm_only` transcript note (text is Rigwell's).
    Thresholds are not in the spec; these are mine and configurable.
126. **Todo nudge**: not built; there is no todo tool in this build. (Superseded by #204.)
127. **Compaction** (`src/agent/compaction.ts`): trigger before each model request when the estimated context (last reported call + chars/4 of
    what was added since; chars/4 of the whole prefix when no call was reported) reaches `compactionTokenLimit`, else the model's
    `maxContextLimit` (default 200,000) minus the 16,000 reserve. `compactionThresholdCheckEnabled: false` turns it off; after a compaction
    another automatic one waits `minCallsBetweenCompactions` model calls. Numbers (settings `compaction`): reserve 16,000, target 4,000,
    headroom 8,192, custom cap 8,000, post ceiling 40,000, keepRecentTurns 2, toolResultCapChars 4,000. Summarizer limit = min(reserve,
    model maxOutputTokens or 8,000); `max_tokens` = limit + 8,192, clamped to maxOutputTokens when set; both logged. The reserve is not grown
    for carried items (there are none: no todos). The summarizer runs with reasoning off, no tools, on `compactionModelId` (session setting, (Superseded by #204: the reserve grows by the carried todo list.)
    default from settings `compactionModel`, else the session model; for "auto", the routed model).
128. **What is kept**: the recent turns kept verbatim are the last `keepRecentTurns` (2) turns, fewer if they exceed 40,000 minus the target
    summary minus the re-injected context, and never all turns (something must be summarized; one huge turn is folded entirely). A cut falls on
    a turn start (a user message without tool results), so tool calls and results are never split. The transcript sent to the summarizer drops
    `user_only` messages and thinking, caps each tool call and result at 4,000 characters (then 1,500, 400, 100 if the window is too small),
    and replaces environment, session, todos, project instruction, skills and long `<system-reminder>` blocks by the omission marker.
    `customInstructions` are appended to the user message as a short paragraph (Rigwell text).
129. **After compaction**: the history is one `llm_only` message `context-compact-<uuid>` (summary preamble, then the old context blocks as
    they were, then one reminder with the loaded deferred tools' signatures and the still-deferred names), then the kept turns. System
    blocks and tools are untouched; the cache monitor names the cause "compaction". Messages replaced are kept in `session.archived` for the
    UI (`uiMessages()`); `load_session` shows the full conversation.
130. **compaction_state record** (spec 12.1) is appended to the transcript with the spec's fields plus `reason`, `preambleMessageId`,
    `preambleBlocks` (the rebuilt first message). `anchorMessage` is the last message the summary covers; on load the latest record gives
    the preamble, and only messages after the anchor follow. `summaryTokens` is chars/4 of the summary. `loadedDeferredToolNames` is merged
    with the settings file's list on load. Hooks (PreCompact) belong to Phase 5. (Superseded by #147: hooks are wired; PreCompact runs before a compaction and can cancel it.)
131. **compact_session** compacts in place: `newSessionId` is the same id (the spec's record lives in the same transcript), `removedCount` the
    number of messages replaced. It fails with CONFLICT while a turn runs, and with an internal error (history untouched) if there is
    nothing to compact or the summarizer fails. `mode: "handoff"` (meaning not in the spec) keeps no recent turns: everything goes into the
    summary. `session_compacted` carries `summaryId` (record id), `removedCount`, and `visibleBoundaryMessageId` = the first message kept
    verbatim (null when none). Working state `compacting_conversation` is emitted during the summary.
132. **Routing** (`src/agent/router.ts`): model id `auto`, with settings `autoRouter` {classifierModel, candidates [{model, description,
    inputCost}], threshold 0.7, timeoutMs 10,000}. Per model request: classifier input = current request, last 8 tool calls, last 6 messages,
    in that priority within 16,000 tokens (chars/4), long text cut to 2,000 characters at each end; 8,192 max output, low reasoning, no
    retries. Pick = cheapest candidate with score at least the bar (ties: higher score), else the best, else (all zero) the first;
    fallbacks by score. Reasons: policy (one candidate), hard, routine (75 percent or more qualify), task_fit, fallback (classifier failed,
    first candidate). Recorded as `effectiveRouterModel` in the session settings. When the picked model fails after its retries, the next
    fallback is tried (the cache monitor logs "router fallback"). Cleared on compaction. Tool mode is decided for the session model
    ("auto" is direct_only unless overridden), not per routed model, so the tool list does not flip. The classifier prompt is Rigwell's own.
    No image handling (images are not supported in this build). (Superseded by #205 for images in the loop; the classifier still sees text only and drops image blocks, which is intended.)

## Phase 8: Desktop app

133. **Stack:** Electron 42.3.3 (spec §14), in `desktop/` with its own `package.json`. Renderer is React 19 plus xterm.js only. TanStack Router and
    Query, Jotai, tiptap, shiki, mermaid and KaTeX from §14.7 are not used (the brief says keep dependencies few): routing is a hash
    router, state is a small external store, markdown and syntax highlighting are small in-repo modules (`renderer/lib/markdown.ts`,
    `highlight.ts`; output is escaped before any tag is added). Build is `bun run build.ts` (Bun.build, CommonJS main and preload, ESM
    renderer) instead of Vite and Electron Forge; no installers or makers. `ws` is the only other runtime dependency (the CDP proxy).
134. **Daemon transport is the WebSocket mode:** the daemon is a Bun program, so the app starts `rigwell daemon --socket <home>/daemon.sock
    --ws-port 0` and talks to its token-protected loopback WebSocket (the debugging mode §14.1 allows) instead of Node child IPC.
    The main process owns the sockets (one per session view) and relays strings over `daemon:sendMessage` (strings only, sender frame
    checked). Command override: `RIGWELL_DAEMON_CMD` (JSON array); default `bun <repo>/src/cli/main.ts`. A packaged build must bundle the bun
    binary; packaging is not built.
135. **Supervisor:** `desktop/main/supervisor.ts`. Ready means daemon.json carries the child's own pid and token and the WebSocket port answers
    HTTP 401 within 30 s (the daemon has no `/health` route; a 401 without a token proves the listener). Auto-restart 3 times with 2 s, 4 s,
    8 s; the count resets on ready; manual restart; stderr log rotates at 1 MB to `.old`; crash breadcrumb in
    `logs/daemon-critical-error.json`; after the third failed restart the app shows a dialog naming the likely causes. "Port held by an old
    process" handling is not needed because the port is 0 (picked by the OS). Windows' `--parent-pid` and the liveness fd are not built:
    the daemon is stopped with SIGTERM then SIGKILL when the app quits.
136. **Files:** `daemon.list_files`, `search_files`, `get_workspace_file_content`, `write_workspace_file_content` as in §17.1. Fingerprint is the
    sha256 of the bytes; a mismatching `baseFingerprint` fails with -32006 and the current fingerprint in `data`. Writes go through a temp
    file and rename and keep the mode. Reads may use an absolute path outside the working folder (session owner); writes may not, and
    symlinks are resolved first so they cannot escape. Writes refuse binary files, files over 15 MB and missing files (no create).
    Listing uses ripgrep when installed, else a directory walk; `.git` and `node_modules` are skipped in the fallback only.
137. **Terminals:** PTY through `Bun.spawn(..., { terminal })`, so there is no native module. Scrollback is the raw output as a capped string
    (1,000,000 chars) that the renderer writes back into xterm.js, instead of a headless xterm with 50,000 lines; `plainText` strips escape
    codes. Ids are scoped by session. Ownership, 30 s grace timer, adoption through `daemon.list_terminals` and the 30 minute orphan sweep
    follow §17.2. Shell allow-list and protected environment keys follow §17.2.
138. **Browser pane:** the app's webviews register with the main process, which exposes them as one browser through a loopback CDP proxy
    (`desktop/main/cdp-proxy.ts`, path `/devtools/browser/<random id>`, so the URL is a capability). The renderer attaches that URL with
    `daemon.browser_attach`; the daemon accepts only ws, 127.0.0.1, the port in `RIGWELL_BROWSER_CDP_PORT` (set by the supervisor), a
    `/devtools/browser/<id>` path, no credentials, query or hash (§17.3). The daemon side is its own small CDP client
    (`src/sidepane/browser.ts`), not Playwright, so no extra dependency; it works against any CDP browser, which is how the tests use headless
    Chromium. The agent gets one tool, `Browser` (tabs, open, select_tab, close_tab, navigate, back, forward, snapshot, click, type, press,
    screenshot, evaluate). `snapshot` numbers interactive elements; refs are valid until the page changes. Screenshots are saved under
    `$RIGWELL_HOME/browser-screenshots` and the path is returned (tool results are text). No agent-browser skill is shipped (on the approval
    list). Idle connections close after 30 minutes.
139. **Where the Browser tool is registered:** `createConnection` got an optional `extraTools` option (3 lines in `src/daemon/connection.ts`);
    the daemon passes the side pane's tools. `src/permissions/gate.ts` got a `Browser` case: tabs, snapshot and screenshot are allowed; other
    actions are allowed at autonomy low or higher and ask at off. Chrome cookie import (ask Scott) is not built.
140. **Side chat is a fork, not a fresh session.** On a question the main conversation is copied up to its last settled point (an assistant message
    with no open tool call) into a second in-memory session with the main session's model; a fork of a busy main session therefore never sees
    the running turn. The fork has read tools only (Edit and Create removed) and permission requests are auto-rejected, so it cannot change
    anything; the spec's "unless the user turns writes on" switch is not built. Earlier exchanges (up to 10, question 1000 chars, answer 4000)
    are carried into a new fork as possibly stale context. The fork is closed when no question is pending. Nothing is written to disk or to
    the main transcript, so the spec's `btw` folder, tags and Promote are not built. Methods: `daemon.side_chat_ask`, `side_chat_list`,
    `side_chat_cancel`; notification `daemon.side_chat_entry`. (Superseded by #244: forks are stored under btw/ with the btw-fork tag, Promote and the writes switch are built.)
141. **Attention events** (§19.1) are computed by `src/sidepane/attention.ts` and fed by the main-process broker, which sees both the daemon's
    notifications and requests and the window's answers. The daemon's connection layer belongs to another phase, so the mapping is not
    inside the daemon yet; the events are the same. Notification, badge and sound rules are pure functions in `desktop/main/alerts.ts`:
    toast skipped when the window is focused on that session; completion sound off by default; awaiting-input sound `ack`; focus mode,
    volume and subagent quiet mode as in §19.3. Sound settings live in the desktop settings file (`sounds`), not in the agent settings.
    Built-in sounds are generated in code (`desktop/main/sounds.ts`), so no audio files ship. The BEL and OSC progress output of the TUI
    is not part of this phase.
142. **Appearance before first paint:** the main process reads `desktop-settings.json` synchronously before it creates a window, sets
    `nativeTheme.themeSource`, creates the window with the resolved theme's startup background (defaults `#161413` and `#f2f0f0`) and the
    title-bar overlay colors, and passes the boot values to the preload as a process argument. `boot.js` (a blocking script in `<head>`) applies
    `data-theme` and the CSS variables with the same pure function the tests cover (`applyBoot`). A theme change updates the page first, then
    saves, then the main process updates the window background and overlay. The theme file format is JSON tokens per theme, importable and
    exportable on the Appearance page.
143. **Desktop settings keys** (§14.4): `keepAwakeEnabled`, `desktopAutoUpdateEnabled`, `locale`, `windowZoomLevel`,
    `automationQuitWarningDismissed`, plus `autoOpenFilePreviews`, `appearance`, `notifications`, `sounds`, `disabledShortcuts` and
    `windowBounds`. Updates have no feed in this build: Check for Updates says so. Single instance, deep links (`rigwell://sessions/<id>`,
    `mcp-callback` claimed by a window for 10 minutes), menus, deny-all `window.open`, the external-link allow-list, CSP (meta tag and header),
    `contextIsolation`, `sandbox`, no `nodeIntegration` and webview limits follow §14.2 and §14.6; Electron fuses are not flipped (that needs a
    packaging step).
144. **Not built in the shell:** tray icon (ask Scott), Mission Control and Automations pages (their phases), Session Defaults, Missions,
    Custom Models, Worktrees, Connectors, Session Management and Usage settings pages, per-session Pin, Rename and Archive (no daemon
    methods exist yet), Share (hosted), model cost multipliers, the Connectors and Skills dialogs, per-window zoom file, image attachments,
    voice dictation, API keys, secrets and environments pages (approval list). Settings pages built: General, Appearance, Notifications and
    sounds, Support. (Superseded by #196 to #201 and #210 (pages, dialogs, Pin, Rename, Archive), #200 (Mission Control), #242 (image attachments) and #245 (per-window zoom file); the tray icon, Share, cost multipliers, voice, API keys, secrets and environments are still not built.)

## Phase 5: Wiring into the loop

145. **Tool sets**: Skill is offered when a model-invocable skill exists at session start (the tool array never changes later). Task is offered at autonomy high or with skipped permissions, at depth 0, never in spec mode; in Scripts only with `allowSubagentsInScripts` (initialize_session, saved in the session settings); in script_only it is top level otherwise. ExitSpecMode is offered only in spec mode and only when a client can answer (not headless). Spec mode keeps Edit and Create at autonomy off (plan files); the gate still asks for them at off.
146. **Context order** (prompts.md 4): environment, project instructions, skills, session, todos, then SessionStart hook context. Lazy instruction files and skills found after Read/Edit/Create arrive as `llm_only` reminders at the start of the next turn. After compaction the skills block in the re-injected context is rebuilt (dynamic skills included) and discovery resets.
147. **Hooks**: SessionStart runs at start (turn 1 waits, at most 60 s); UserPromptSubmit may block (turn reason `prompt_rejected`); PreToolUse runs before the gate for direct and inner Script calls; PostToolUse once per outer call (decision 3); Stop sends the agent back with no cap (decision 4); stop/abort from a hook end the turn (`completed` with a note / `error`). A rewritten Execute command loses riskLevel/riskReason unless `preserveRiskLevel`, and then asks even if the risk would pass. Subagent sessions run only the tool hooks; the parent fires SubagentStop.
148. **MCP**: one McpManager per session, started from `start()` (not awaited). Tools register as deferred `server__tool`. `mcp_status_changed` carries `{server: McpServerStatusInfo, summary}`. Permission: confirmationType `mcp_tool`, options proceed_once / proceed_always_tools / proceed_always_server / cancel; the last two are saved in user settings `mcpAlwaysAllow` `{tools:{name:impact}, servers:[...]}`. Impact is always "high" (no annotations are read).
149. **Subagents**: an in-process child Session in the same process; own transcript with `callingSessionId`/`callingToolUseId` and settings tag `subagent`; headless parents make children auto-reject; interactive parents relay child prompts. Child usage is added to `inclusiveTokenUsage` and `childInclusiveTokenUsageBySessionId` when the child ends. A background Task is a `TaskJob` (kind `task`). Custom-agent `mcpServers` are not honoured.
150. **Spec mode**: spec model/effort via `specModeModelId`/`specModeReasoningEffort` (init, update_session_settings, sessionDefaultSettings.specModeModel). ExitSpecMode details `{plan, title, filePath, contextSavingsPercent, supportsClientStartedHandoff}`; options proceed_once, proceed_auto_run_low|medium|high, proceed_edit (`editedSpecContent` in the answer), cancel. Approved specs are saved to `specSaveDir` (default `.rigwell/docs`) as `YYYY-MM-DD-<title>.md`. The tool result says spec mode ended.
151. **fork_session** copies the transcript and settings with `parent` set; refused while a turn runs. The TUI `/context` maps the harness `breakdown` to its categories.

## Phase 11: Missions v1

152. **Wiring.** Mission code is in `src/missions/`. The daemon connection got one option, `wrapTools(tools)`, and `mission` joined the interaction modes; `gate.ts` treats mission mode as autonomy high and allows the four mission tools (they confirm with the user themselves). `daemon.ts` attaches `createMissionService().attach(conn)` per connection (tool wrapper plus methods `enter_mission_mode`, `mission_get`, `mission_list`, `mission_pause`, `kill_worker_session`). `update_session_settings` stores `missionSettings` in the session settings file.
153. **Roles and tools.** The orchestrator tools exist only while the session is in mission mode; workers get only EndFeatureRun. Edit and Create are added to a mission-mode orchestrator even at autonomy off. File protection wraps Read, Edit, Create, Grep, Glob (output lines filtered) and Execute (a command that names a mission-folder system file is refused, a string check). Workers may read `features.json` but not write it. Writes to `features.json` and `validation-state.json` are validated after the write and rolled back with an example when invalid.
154. **Workers** are separate in-process sessions (`worker.ts`): own connection, `canPrompt` false, autonomy high, auto-reject, tags `exec` and `mission {role, missionId}` in the session settings. A paused worker is reloaded with `load_session`. The worker is done when its turn ends; no EndFeatureRun means requeue and `orchestrator_turn`. Without a prompting client (headless) the ProposeMission and StartMissionRun confirmations are accepted automatically.
155. **State extras.** `state.json` also holds `pauseReason` and `scopeGrowthPaused`. Pause reasons: `feature_retry_limit_exceeded`, `scope_growth_limit_exceeded`, `unrecoverable_usage_402` (error text with HTTP 402, billing or quota), `crash_recovery`, `user_paused`, `user_interrupt`. Retry limit pauses when attempts (worker session ids on the feature) reach 5 plus bonus; resuming from that pause adds 5 to every exhausted feature.
156. **Handoff gate** treats a handoff as unaddressed when it has issues, undone work, a non-success state or `returnToOrchestrator`, until a later `handoff_items_dismissed` entry exists or the orchestrator edits `features.json` or `mission.md`. The system's own `features.json` writes are told apart by a `features.sysmtime` file.
157. **Validators** are queued at the top as `scrutiny-validator-<m>` and `user-testing-validator-<m>` once a milestone's implementation features are all complete (one `milestone_validation_triggered` entry per milestone, skip flags honoured). They have no SKILL.md; their role text is in the first message. Validators use the validation model pair, falling back to the worker model, then the orchestrator model; an unknown model is replaced by the orchestrator model and logged as `substitutedFromModelId`.
158. **Readiness** runs in `enter_mission_mode`: a non-OK result returns `entered: false` with options unless `continue: true` (which records the folder). Mission-allowed models and the orchestrator model come from settings `missions {allowedModels, orchestratorModel, orchestratorReasoningEffort}`. Timeouts: `RIGWELL_MISSION_WORKER_INACTIVITY_TIMEOUT_MS` (default 600000, plus 300000 before a worker's first activity), heartbeat 180 s. Wake lock is skipped when `RIGWELL_NO_WAKE_LOCK=1`.

## Gap wave: Execute sandbox

169. **Per-command sandbox only.** `whole-process` is accepted in settings and reported (`sandbox.mode`, with a note) but commands are still sandboxed per command; relaunching the agent inside the sandbox is not built. Default is `enabled: false`. Status is reported through `sandboxStatus()` / `settingsSnapshot().sandbox` as `{enabled, mode, active, available, engine, reason?, note?}`; the TUI `SANDBOX` marker should show when `active` is true. (Done in #239: the TUI shows SANDBOX while `active` is true.)
170. **Engines.** Linux: bubblewrap (read-only root, private `/tmp` tmpfs, writable working folder + Rigwell home + `allowWrite`, read-only certs/bin/tools/org-cache/credentials, credential dirs emptied and credential files bound to `/dev/null`, new pid/ipc namespaces, `--new-session`). macOS: `sandbox-exec` profile (generated and unit-tested; not run on this Linux host). No seccomp filter is built (documented gap). Unavailable engine: Linux/macOS fail closed (Execute returns an error); Windows reports unavailable and runs unwrapped, relying on 5.5.3.
171. **Network.** No allowed domains: `--unshare-net` (deny all, kernel-enforced). `"*"` with no deny list: network shared. A domain list (or `"*"` with a deny list): `--unshare-net` plus a per-command HTTP/CONNECT proxy on a unix socket, bridged into the sandbox by `socat` on 127.0.0.1:3128 with `HTTP(S)_PROXY` set; programs that ignore the proxy have no route. Without `socat` a domain list degrades to deny all. SOCKS, `allowUnixSockets`, `allowAllUnixSockets` and `httpProxyPort` (Linux) are typed but not enforced. Vendor API hosts are added through the `vendorHosts` option (empty by default: Execute commands do not need the model API).
172. **Violations.** Detected from stderr (EROFS, or EACCES/EPERM on a path outside the writable set), from the command text naming a denied read path (denied files read back empty, so there is no error to catch), and from the proxy (host blocked). Up to 500 are kept per session. Each unique target raises a `sandbox_violation` request (max 5 per command) with options `proceed_always` (parent dir, or the domain), `proceed_always_file` (exact path), `proceed_once` (session only), `remove_from_deny_list` (deny-list reasons), `cancel`. "Always" saves to `$RIGWELL_HOME/settings.json` `sandbox`. The command is not re-run automatically; the result tells the model to run it again. Credential files, certs, bin/tools and the org cache are never offered. A declined target is not asked again in the session.
173. **Org merge** is the pure `mergeSandboxOrg(org, user)`: enabled if either enables, `whole-process` beats `per-command`, allow lists intersected, deny lists unioned, permissive switches need both sides. Single-user build has no org source; the controller takes an `org` option.
## Gap wave: Chat Completions adapter

159. **Provider `generic-chat-completion-api`** (`src/adapters/chat.ts`): streamed `POST <baseUrl>/v1/chat/completions` with `stream_options.include_usage`, `max_tokens`, `prompt_cache_key` = session id, tools as `{type:"function", function:{...}}`, `reasoning_effort` when the effort is not off/none/dynamic (`max` is sent as `high`). Cached tokens come from `usage.prompt_tokens_details.cached_tokens` (uncached input = prompt tokens minus cached). A stream that ends without a `finish_reason` is a retryable network error. `noImageSupport` defaults to true for this provider.
160. **Reasoning storage.** Reasoning is read from `delta.reasoning` first, then `delta.reasoning_content`. It is stored as a thinking block with `signatureProvider: "chat"` and `signature` = JSON `{f: <field name>, g: {<tool call id>: <thought_signature>}}`; other adapters ignore such blocks. On replay an assistant message with tool calls carries the reasoning under the recorded field (profile field, else any field seen in the history, else `reasoning_content`), a single space when empty. To avoid sending an unknown field to strict servers, the empty-space form is only sent when reasoning effort is on or a reasoning field was seen earlier in the history.
161. **Quirk profiles** are chosen by the optional custom-model field `apiProvider` (`mistral`, `together`, `baseten`, `databricks`, `google`; anything else uses the default). mistral replays reasoning as `thinking` content parts and sends no reasoning field; together and baseten send no reasoning history, together sets `reasoning.enabled`, baseten sets `chat_template_args.enable_thinking` and turns effort off/none into `reasoning_effort: "low"`; databricks drops `background`, `previous_response_id`, `store`; google reads and replays `extra_content.google.thought_signature` per tool call.
162. **Override merge order** is profile < model `chatCompletionRequest` < `chatCompletionRequestByProvider[apiProvider]`; `extraArgs` is applied after all three (explicit user fields win), and then the profile's unsupported fields are removed. `apiProvider`, `chatCompletionRequest` and `chatCompletionRequestByProvider` are optional `customModels` entry fields.

## Phase 7: Perf

163. **First-keystroke p95** is measured in-process (fake TTY into `runTui`, in-process session, long answer on screen, stdin event to redrawn frame on stdout) and gated at `max(baseline x 3, baseline + 10 ms)` capped at the 250 ms spec target. A pty run of the real process is also gated at the 250 ms cap. Sub-millisecond baselines need the absolute slack to avoid CI noise. A failing p95 is re-measured once before the gate fails. Method in `perf/README.md`.
164. **Other section 7 metrics** (turn preparation, tool lookup, exec first request, daemon ready, per-session memory, quit, first paint, first prompt accepted) are measured and reported against their targets but not gated: they depend on the machine. All were far under target when measured, so no startup change was needed.
165. **Base-prompt gate** reuses `BASE_PROMPT_BUDGET` and `requestSizes` from Phase 3; the gate fails if any part exceeds its budget. `perf/baseline.json` is rewritten only by `bun perf/gate.ts --update-baseline`.
166. **CI**: `.github/workflows/ci.yml` pins Bun 1.4.4, runs typecheck, `bun test` and the perf gate. The Electron tests are in a separate optional job (npm install in desktop/, Xvfb) with `continue-on-error`.
167. **Session turn-queue race fixed** (found by the turn-preparation benchmark): a message added after `drain()` made its last queue check but before `currentRun` was cleared was never run. `kick()` now restarts the drain when the queue is non-empty once the run ends. Test: `test/agent/queue-race.test.ts`.
168. **Flaky Script sandbox test root-caused** ("printed text keeps head and tail over 64 KiB", reproduced 1 in 16 with 16 parallel runs): the runner called `process.exit(0)` straight after a large burst of output, so a full stdout pipe lost the tail and the `done` message. The runner now exits after stdout is flushed (`exitAfterFlush`), and the host waits (at most 2 s) for its stdout reader to drain before treating a child exit as a crash. The "at most 128 calls in flight" test also depended on pipe speed (peak 52 under load); calls are now held until the cap is reached, so the assertion is `peak === 128`.

## Gap wave: file snapshots and rewind

169. **Store.** `$RIGWELL_HOME/snapshots/` holds `manifests/<sessionId>.snapshots.json`, `content/<2 hex>/<rest of sha256>` and `.index.json` with the §12.1 field names. One boundary per user message, created on the first Edit or Create inside the turn. Per boundary: `files` (bytes before the change, `mode` "modify"; "delete" is reserved for a future delete tool), `creations` (paths that did not exist), `deletions`. The manifest also carries two Rigwell fields: `lastWrites` (hash the agent left each path in, for the stale check) and `evictedThroughMessageId`. Files over 20 MB are not captured. Child (subagent) sessions are not captured. `RIGWELL_SNAPSHOTS=off` disables capture.
170. **Eviction.** Total stored size (sum of boundary sizes, no dedup credit) is capped at 512 MB (`RIGWELL_SNAPSHOT_MAX_BYTES` overrides). Past the cap the oldest boundaries of any session leave first (never the one being written), their blobs are deleted when no queue entry references them, and the manifest gets `evictedBoundaryCount` / `oldestAvailableBoundaryIndex`. Rewinding with restoreFiles to or before an evicted boundary is an error; rewinding without restoring still works.
171. **Rewind semantics.** `rewind_session {messageId, restoreFiles?, force?}` ends the model-visible conversation at that user prompt (the prompt stays, everything after it goes). Files return to their content when that prompt was sent: for each path touched at or after the boundary, the earliest captured content is written back, and files the agent created are removed. A `rewind` record is appended to the transcript; no line is deleted, and `load_session` drops the rewound messages from the model view (`LoadedSession.rewound` keeps them) and ignores a compaction whose anchor was rewound away. Restored boundaries are dropped from the manifest.
172. **Refusals.** Stale check: if a file to restore no longer hashes to what the agent last wrote, the whole rewind is refused (CONFLICT, nothing changed) unless `force`. Targets must be real user prompts; a message already summarized by a compaction is transcript-only and rewinding to it is an error (spec §12.1 fork rule, applied to rewind). Also refused while a turn runs. Error data carries `reason` (`busy`, `not_found`, `not_a_prompt`, `transcript_only`, `stale`, `evicted`, `missing_content`) and `files` for stale.

## Gap wave: TUI

173. **Custom slash commands** (spec §12.2 names a `commands/` folder but gives no format): Markdown files, one per command. Project `<root>/.rigwell/commands/<name>.md` wins over user `$RIGWELL_HOME/commands/<name>.md`. The file name is the command name; optional frontmatter `description` and `argument-hint`; the body is the prompt. `$ARGUMENTS` is the text after the command, `$1`..`$9` are single words; with no placeholder, typed arguments are appended after a blank line. Names that clash with a built-in command are skipped. Commands and user-invocable skills are listed in the `/` menu; a skill runs by sending its body in a `<skill>` wrapper as the turn text (in-process read of the skill files; the transcript shows the typed `/name args`). Files are read at session start and after `/mcp`; `/new` picks up changes.
174. **Config views** (`/mcp`, `/hooks`, `/skills`, `/commands`, `/agents`, `/diagnostics`, `/statusline`): read-only overlays. MCP uses `list_mcp_servers`, `add_mcp_server` (`/mcp add <name> <url|command> [args]`, `--sse` for SSE) and `remove_mcp_server`; hooks, skills, agents and settings are read in the TUI process with the loaders in `src/hooks`, `src/skills`, `src/subagents`, `src/storage/settings.ts` (the TUI runs on the machine that owns those files, also when it talks to a daemon). `/diagnostics` counts failed MCP servers, settings warnings, hook warnings and invalid skills as issues and the footer shows the count.
175. **Status line command** (spec §13.1 leaves the input unknown): the command runs through the shell with a 2 s timeout, working folder = session folder, and gets one JSON object on stdin: `{session_id, cwd, version, model:{id,display_name}, mode, autonomy, reasoning, running, context:{used_tokens, limit_tokens, used_percent}}`. The first `maxRows` (1-3) lines of stdout, with escape sequences stripped, are drawn above the status bar, indented by `padding`. It refreshes after every turn, at session start, and about every 5 s while idle (every 30 s after a failure). A failure shows "Status line ... Run /statusline." in its place.
176. **Attention** (spec §19.1, §19.3): on a completed (not cancelled) turn the TUI writes BEL when `enableCompletionBell` is true and plays `completionSound` (default off); on a permission, AskUser or picker request it plays `awaitingInputSound` (default `ack`). Sound keys are read from the top level of settings (§12.2) or under `general` (§19.3). Values: `off`, `bell`, `ack`, `ok` (two short tones generated at run time into a temp WAV, so no audio asset is shipped), or a file path. Players: `afplay`; Linux `paplay`, `aplay`, `ffplay`. A player that cannot scale volume gets a rescaled temp copy of a 16-bit PCM WAV (at most 25 MB); timeout 5 s; on failure the bell rings, only at volume 100. `soundFocusMode` uses terminal focus reports (CSI I / CSI O; unknown counts as focused). `subagentSounds` is not built: the TUI sees no nested-agent notifications. (Scope: this entry describes the TUI only. The desktop does build `subagentSounds`, see #141.)
177. **OSC 9;4 progress** (spec §19.2: timing not checked): indeterminate progress (`9;4;3`) while a turn runs, paused/warning (`9;4;4`) while a permission, AskUser or picker request waits for the user, cleared (`9;4;0`) when idle and on exit.
178. **Steering** uses `add_user_message` with `queuePlacement: "end_of_loop"` at once; the message is listed under "Steering messages" until the next tool result (the harness delivers it after the next tool call) or the end of the turn, then it joins the transcript. Ctrl+Enter queues on the client (`end_of_turn` behaviour) so Ctrl+G and Ctrl+X still work on queued messages; a steering message is already with the harness and cannot be pulled back.
179. **Rewind**: `/rewind-conversation` and double Esc on an empty input list the session's user messages (those with a message id), then ask "restore files" or "conversation only" and call `rewind_session {messageId, restoreFiles}`. On success the transcript is cut before that message and its text goes back into the input box. History loaded from a session keeps its message ids; steering messages shown from the pending list have none and cannot be picked.
180. **Scrolling**: PageUp/PageDown and Alt+PgUp/PgDn move one page, Alt+Up/Alt+Down one user turn (spec §13.3; the §13.7 v1 cut leaves paging out, it is built anyway at low cost). The view stays where it is while new text arrives and shows "N more lines below"; sending a message jumps to the bottom.
181. **Other commands**: `/sessions` uses `list_sessions` (falls back to a local scan when the harness lacks it); `/rename` uses `rename_session`; `/automations [pause|resume|run|delete|history <id|name>]` and `/loop` (`30m <prompt>`, `<prompt> every 2h`, `list`, `stop [id|all]`, empty prompt reads `loop.md` from `<project>/.rigwell` or the data folder) use the automation and cron methods and need a daemon connection (`--daemon`). `/btw` is marked "-" in the §13.2 v1 column and is not built.

## Gap wave: worktrees and automations

182. **Fetch from origin:** `worktree.pullFromOrigin: true` runs `git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>` before `worktree add` (`<b>` = base branch in copy mode, the branch in existing mode). On success a copy-mode worktree branches from `origin/<b>` (the recorded `baseRef`); a failed fetch is logged and the local base is used. The result carries `fetched`.
183. **Rename after title:** `onSessionTitleUpdated(sessionId, title)` (called from the connection when a `session_title_updated` notification with `updateType` other than `manual` passes through its notify) renames a generated branch to `branchSlug(title)`. Skipped when the user chose the name, the branch has local-only commits, an upstream, the user switched branches, or it was already renamed once. Session settings `worktree.branch` is updated.
184. **HEAD watching:** `HeadWatcher` watches the worktree git dir (git swaps HEAD by rename, so the file itself is not watched), debounced 150 ms, and reports only a real change of branch name as `rigwell.worktree.branch_changed {worktreePath, sessionId?, branch, previousBranch}`. Watches start with the session and stop on release or removal.
185. **Removal broadcast:** every removal (cleanup method, auto-delete, archive, housekeeping, failed start) emits `rigwell.worktree.removed {worktreePath, sessionId, repoRoot, branch}` and forgets trust. Creation marks the new folder in `trustedFolders` of the user settings.json.
186. **Housekeeping (5 min):** `Housekeeper.tick()`: archive sessions whose worktree folder is gone (writes `archivedAt` in session settings), remove orphaned ephemeral worktrees (session archived or unknown, setup receipt older than 24 h, safe: no user work, no local-only commits, not pinned/reserved/in use), `git worktree prune` per repo. Clock and timer are injectable. The daemon starts it. Archive removal: `onSessionArchived(sessionId)` in `src/worktree/connect.ts` removes the session's ephemeral worktree when safe. `archive_session` did not exist in the base this was built on, so the call is not wired; the method that writes `archivedAt` should call `onSessionArchived(sessionId)` afterwards.
187. **Profile index:** local `index.yaml` holds `lastUsedProfileId` (set when a session starts with a profile) and `deleted:` entries (name + cleanup script). `deleteLocalProfile` writes the tombstone; `findProfile` answers from it, so old worktrees still run the cleanup script. New methods `list_worktree_setup_profiles {repoRoot}` and `delete_worktree_setup_profile {repoRoot, profileId}`.
188. **Auto-pause:** a final failure (after its retry) counts one; 3 in a row (`maxConsecutiveFailures`) pause the automation with `pausedReason: consecutive_failures`. The first scheduled slot after the anchor being more than 10 days old pauses it with `missed_runs` instead of a catch-up run. A user resume clears the reason and the count and restarts the missed-run clock (`resumedAt`). Broadcast: `rigwell.automation.auto_paused {id, name, reason}`. Failures flagged `host_slept` do not count.
189. **host_slept:** the tick loop remembers each detected sleep span (gap over 150 s); a run that fails while overlapping one is recorded as `host_slept`. Time asleep is not counted toward the 6 h limit because the runner's timer is monotonic.
190. **mcp_unavailable:** before the prompt goes in, the headless runner polls `list_mcp_servers` until none is connecting (30 s cap). A failed or still-loading server sets `mcpUnavailable` on the run record; the run carries on, and if it then fails with `agent_error` the reason becomes `mcp_unavailable`.
191. **Natural-language schedules:** `naturalToCron` is a fixed grammar: `every weekday|weekend|day|<day>[, <day> and <day>]`, `daily`, `weekdays`, `weekends`, `monthly [on the Nth]`, `on the Nth of every month`, `every hour`, each with an optional `at <time>` (also in front); times are `9am`, `9:30pm`, `18:30`, `noon`, `midnight`, `9`; no time means 09:00. The cron is stored when the automation is created or edited. `every N minutes|hours|days` stays an interval; presets and cron are kept as written. Anything else throws a `ScheduleError` listing the accepted forms.
192. **Agent tools:** `CreateAutomation`, `ListAutomations`, `ReadAutomation`, `EditAutomation`, `DeleteAutomation`, `RunAutomation`, `Loop` (start/list/stop) are ordinary tools added through `extraTools` (not deferred: the deferred registry is session-internal). Gate: List/Read and `Loop list` allow; the rest always ask, so an unattended run, which cannot prompt, cannot create or change automations. `scope: "project"` stores the automation in the session's project and registers it.
193. **Project registry:** `$RIGWELL_HOME/automation-projects.json` lists known project folders, loaded by the manager at start; `create` with a project folder, the tools, and `rigwell.register_automation_project` add to it.
194. **Notification names:** `rigwell.cron.state_changed {cron}` replaces `rigwell.cron_state_changed`; it also fires on create, update and delete of a cron, not only on a fire.
195. **userMessageSource:** `Session.addUserMessage(text, messageId?, source?)` takes an optional source, stored on the message (`userMessageSource`, also in the transcript). Cron fires and automation runs pass `"automation"`; `add_user_message` forwards the param.

## Gap wave: desktop pages

196. **Agent settings from the desktop:** there is no settings RPC, so the Electron main process reads and writes `<home>/settings.json` (`userSettings:get/update/trustFolder`). `customModels` API keys and header values are masked (`****` + last 4; `${VAR}` references stay visible) before they reach the page. A masked value sent back means "keep the stored secret".
197. **Skills dialog:** no skills RPC exists, so the main process lists skills with the shared `SkillRegistry` (`skills:list`). Inside Electron `Bun.YAML` is absent, so SKILL.md front matter uses the simple key/value fallback parser. `list_tools` is used only to say whether the Skill tool is exposed.
198. **Worktree setup profiles:** the Worktrees page writes local profiles as JSON (valid YAML) to the same folder `src/worktree/profiles.ts` reads; repository profiles are shown read only.
199. **Connectors / Usage settings pages:** they need a daemon session, so they load the most recent stored session on a short-lived connection (MCP list/add/remove; `load_session` token usage and `get_context_stats`). Usage covers the 15 most recent sessions.
200. **Mission Control data:** the list uses `mission_list`; a detail view loads the orchestrator session on its own connection and polls `mission_get` every 2.5 s as well as applying `mission_*` notifications (a mission driven from another window notifies that window's connection). There is no resume RPC, so a paused mission shows its reason and points to the orchestrator session.
201. **Chromium background traffic:** the desktop passes `disable-background-networking`, `disable-component-update` and related switches. The composer exposes `data-ready`, and the session controller waits (3 s at most) for the browser pane to attach before sending, so a Browser tool call cannot beat the attach.

## Gap wave: harness

202. **Tools added.** `LS` (listing with .gitignore via `git check-ignore`, bulky folders hidden, depth 1 to 3, 500 entry cap; Script gets `{path, entries, truncated}`), `FetchUrl` (http/https GET, redirects followed, 30 s, 2 MiB cap, HTML turned into text, `maxChars` default 20,000; asks at autonomy off with confirmation type `fetch_url`, auto from Low), `TaskOutput` and `TaskStop` (work on every job in `src/jobs`: background Task, Execute and Script; `task_id` is the job id; always offered, top level in both tool modes), `TodoWrite` (offered when a client can answer, never in subagents), `AskUser` (same condition), `StructuredOutput` (only while a structured format is active), `ApplyPatch` (below). All are in the permission gate; the session tools allow.
203. **AskUser.** The session sends `rigwell.ask_user {requestId, toolCallId, questions}` and sits in `waiting_for_tool_confirmation`. With no client able to answer (plain `exec`, subagents) the tool is not offered at all; a client that answers with an error or dismisses gives `{cancelled: true}` and the model is told to assume. The Notification hook fires `elicitation_dialog`. In mission mode, a planning mission goes `awaiting_input` while a question is open and back to `planning` after the answer (`Session.onAskUser`). `pick_options` is not built: no tool in this build needs it.
204. **Todos.** `TodoWrite` replaces the whole list; each write appends a `todo_state` record (`{id, timestamp, todos: {todos: [{id, status, content, priority}]}, messageIndex}`) and sends `todo_state_changed {todos}` (an extra notification clients may ignore). `load_session` restores the latest record. A turn that ends with open items gets one `todo-suggest-<uuid>` nudge per turn (llm_only). Compaction rebuilds the `<todos>` block of the re-injected context from the list, and the automatic threshold is `window - reserve - tokens(todo list)` (the reserve grows by what is carried).
205. **Images and files.** Content blocks `image` and `document` (base64) exist; a tool result may carry `images`. Read returns PNG, JPEG, GIF and WebP (checked by their first bytes, 5 MiB cap) as images; with `noImageSupport` the Read is refused and any stored image is replaced by a text note at request time. Anthropic: `image` / `document` blocks, tool_result content as a block list. OpenAI: `input_image`, `input_file`, and `function_call_output` with an item list. Transcript: `{type:"image", mediaType, data}`; a tool_result with images stores its content as a block list. Script `image(base64, mime)` attaches up to 8 images to the Script result. Estimates count an image as about 1,600 tokens and a PDF as 3,000.
206. **add_user_message.** `content[]` (text and image blocks; the `source` form is accepted too), `images[]`, `files[]` (a PDF becomes a document block; `text/*` is inlined as `<file name=...>`). `queuePlacement: end_of_loop` while a turn runs is steering: the message is appended right after the next tool-result message (and sent as `create_message`); if the turn ends before another tool batch it becomes the next message. `end_of_turn` (default) queues. `outputFormat` is the per-message structured format (`null` turns the session one off).
207. **Structured output** (mechanism): a `StructuredOutput` tool whose input schema is the caller's schema (top level, also in `script_only`). A valid call is recorded, the turn ends `completed`, `agent_turn_completed` carries `structuredOutput`, and the outcome record has `resultKind: "structured"`. A call that does not fit returns the problems (a small JSON Schema checker, `src/agent/json-schema.ts`: type, enum, const, properties, required, additionalProperties, items, length and range limits, pattern, anyOf/oneOf/allOf); three bad calls end the turn `structured_output_invalid`. An answer in prose gets one reminder, then `structured_output_missing`. A schema that is not an object schema or has unknown types ends the turn at once with `structured_output_schema_invalid`, with no model call. The tool appears only on turns that have a format, which breaks the cache once (declared to the monitor).
208. **Initialize and load params.** `restrictToolIds` is a hard allowlist over every tool (also what a Script can reach); `disabledToolIds` removes; `enabledToolIds` and `additionalToolIds` add known tools the profile left out (for example `ApplyPatch` under create-edit); read-only autonomy still hides edit tools. `systemPrompt` as a string replaces the base prompt block (the identity line and the Script-mode block stay); `{type:"preset", preset, append}` keeps it and appends the text as a last base block; `systemPromptOverride` is the same as the string. Blank values are `-32602`. `disableBuiltinSkills` drops the built-in skills. All of these, and `structuredOutputFormat`, are saved in the session settings and restored by `load_session` unless the call passes new values. `list_models {includeDisabled: true}` adds custom entries that failed validation with `disabled` and `disabledReason`. Settings carry `routedModelId` and `routedReasoningEffort` while auto routing has picked a model. `update_session_settings` also takes `compactionTokenLimit` and `compactionThresholdCheckEnabled`.
209. **Pending prompts across a reconnect.** Every prompt (`request_permission`, `ask_user`) is kept in the session keyed by `requestId`. If the connection dies while one is open, the wait stays open, and the daemon parks such a session for 30 minutes (`RIGWELL_PARK_MS`) instead of closing it. `load_session` on a parked id adopts the live session and returns `isAgentLoopInProgress`, `workingState`, `pendingPermissions`, `pendingAskUserRequests` (the original request params with `requestId`) and `queuedMessages`; the client answers with `rigwell.answer_request {requestId, answer}` (answer = the response result), which resolves the original wait. An interrupt resolves open prompts as cancelled. An adopted session does not get its worktree hold back (a known gap).
210. **Session RPCs.** `rename_session {title}` appends a `session_title` record, writes `title` and `isSessionTitleManuallySet` to the settings file and sends `session_title_updated {title, updateType: "manual"}`. `pin_session {pinned}` stores `pinned`; `archive_session {archived}` stores `archivedAt` (ISO or null) and calls `onSessionArchived`. `list_sessions {cwd?, includeArchived?, limit?}` works without a session, hides subagent sessions, sessions with no user-visible message and (by default) archived ones, puts pinned first, then newest; `updatedAt` is an ISO time (the desktop reads it with Date.parse; load_session keeps its epoch seconds). The loader applies the latest `session_title` record.
211. **Title generation.** After the first user message of a session a client can see (not subagents, not when a title came with `initialize_session` or `rename_session`), one side request runs: no tools, one system line, the first message cut to 2,000 characters, reasoning off, `max_tokens` 32 + 8,192 (clamped to the model's ceiling), no retries. The first line, stripped of quotes and a final period (80 characters at most), becomes the title and is sent as `session_title_updated {updateType: "auto"}`. A manual rename that lands first wins. Off with settings `autoSessionTitle: false` or `RIGWELL_NO_AUTO_TITLE=1` (the test preload sets it so scripted fakes see no extra request).
212. **Notifications.** `thinking_text_complete` is sent at the end of each thinking block. `tool_execution_heartbeat {toolUseId, toolName}` every `toolHeartbeatMs` (setting, default 10,000) while a tool runs. The Notification hook fires `permission_prompt`, `elicitation_dialog` (AskUser) and `idle_prompt` (a completed turn in a session a client can answer, or a cancelled one).
213. **Denial comment.** `PermissionAnswer.comment` on a cancel is appended to the tool result with the spec's `[Comment]` prefix (§13.4). For a batch, the comment goes to every rejected call.
214. **CLI.** `-r/--resume [id]`: an id is a token of 8 or more characters from `[A-Za-z0-9_-]` right after the flag, so a prompt is never taken for one. Without an id the CLI prints a numbered list (pinned first, newest first, the same data as `list_sessions`) and exits 0. `--fork <id>` copies the session (the `fork_session` code) and continues the copy. `-s` is unchanged. Both work in prompt mode and in the TUI (`TuiOptions.resumeSessionId`). `--use-spec`, `--spec-model <id>`, `--spec-reasoning-effort <e>` become `interactionMode: "spec"`, `specModeModelId`, `specModeReasoningEffort` (prompt mode and TUI; stream-jsonrpc clients send them in `initialize_session`). `--trust` sets `RIGWELL_TRUST_CWD=1`.
215. **Model profiles** (`src/agent/profiles.ts`): the conservative default is direct_only, no overlay, `on_request` line numbers, the provider's own cache strategy, and create-edit (apply-patch for `gpt-*`, `o<digit>*`, `codex*`, `chatgpt*` models on the openai provider). Overlays in order: settings `fileEditToolProfile`, `modelProfiles["*"]`, `modelProfiles[<api name>]`, `modelProfiles[<model id>]`, the custom model's `profile`, its `fileEditToolProfile` and `reasoningField`. Effects: `promptVariant` is one more system block after the base prompt (before a custom agent's prompt); `toolDescriptionOverrides` replace descriptions in the request; `readLineNumbers: always` makes Read number lines unless the call says `lineNumbers: false`; `cache.strategy: none` sends no cache markers (Anthropic adapter); `reasoningField` is carried on `ModelConfig` for OpenAI-compatible adapters; `toolExecutionMode` is used when neither a session override nor `scriptToolModels` decides. Settings keys: `subagentModelSettings {model, reasoningEffort}` (what a Task subagent that says `inherit` uses), `compactionTokenLimitPerModel {<id or api name>: tokens}` (beats `compactionTokenLimit`), `fileEditToolProfile`, `modelProfiles`.
216. **ApplyPatch.** No custom tool type is built, so it is a function with one `input` string (the allowed fallback of §4.6.4), offered instead of Edit and Create under the apply-patch profile. Format: `*** Begin Patch`, then `*** Add File: p` (all lines start with `+`), `*** Update File: p` (hunks that start with `@@`, lines starting with space, `-` or `+`) or `*** Delete File: p`, then `*** End Patch`. A parser checks the grammar; hunks match exactly, then ignoring trailing space, then trimmed; every file is computed first and nothing is written if one hunk fails; Update and Delete need a prior Read. Confirmation type `apply_patch`; blocked in spec mode except for plan files. It does not call the snapshot hooks (rewind does not capture its files yet).
217. **trustedFolders.** A folder is trusted when `RIGWELL_TRUST_CWD=1` (or `--trust`), or it or a parent is in the USER (or runtime) settings `trustedFolders`. Untrusted: project and folder settings, hooks, AGENTS.md style instruction files, project skills, project custom agents and project `mcp.json` are not loaded (the user level still is). `initialize_session` and `load_session` results carry `trusted`. A client that can prompt gets one `rigwell.request_trust {cwd, unlocks}` when the untrusted folder has project config; the answer `{trust: true, remember?: false}` trusts it (and saves it unless `remember` is false). A client without a handler answers with an error, which means untrusted. Headless runs never prompt: trust comes from the flag, the env var or the list. The test suite trusts its temp folders through the `bunfig.toml` preload (`test/preload.ts`).

## Gap wave: client handlers

218. **Trust question in every client.** `rigwell.request_trust {cwd, unlocks}` is answered `{trust, remember?}`; an unhandled request means untrusted, and the harness saves a yes in `trustedFolders`. SDK: `onTrust` option (boolean or `{trust, remember}`; default and on a throw: untrusted). The SDK installs its request handler before `initialize_session` / `load_session` because the question arrives while those run. TUI: a trust panel (Trust / Don't trust, default is not trusting, Esc is no and does not interrupt). The TUI now enters its terminal mode and starts reading keys before the session is created, so the panel can be answered at startup; other keys typed before the session is ready wait in a buffer. Desktop: the asks go into a small app-level store (`trustAsks`) and the existing `TrustDialog` is shown over whatever screen is open (they arrive while Home is still creating the session); Escape and "Don't trust" answer no.
219. **AskUser in the clients.** The TUI panel and the SDK `onAskUser` already matched the harness fields (`requestId`, `toolCallId`, `questions[{index, topic, question, options, multiSelect}]`, answer `{answers[{index, question, answer}], cancelled?}`), so only tests were added. The desktop already had a question panel in the session screen. Not built: typing a free-text answer (the tool text says the user can); all three clients offer the listed options only. (Superseded by #241 for free-text answers.)
220. **Re-shown prompts.** After `load_session`, each client shows `pendingPermissions` and `pendingAskUserRequests` again and answers with `rigwell.answer_request {requestId, answer}` (the harness has no request open towards the new connection). SDK: `resumeSessionId` runs the same `onPermission` / `onAskUser` callbacks (defaults cancel). TUI: `session_ready` builds the panels, marks the session running, and an effect answer for such a panel goes out as `answer_request`; quitting the TUI leaves re-shown prompts open (they are not cancelled) so a later load shows them again. Desktop: prompts carry `reshown`; closing the view does not cancel them, finishing a turn does.
221. **ApplyPatch snapshots.** ApplyPatch calls `ctx.snapshots.before(abs)` for every file it will write or delete before the first write, and `after(abs)` after each write or delete, so rewind restores updated and deleted files and removes added ones.
222. **Parked session adoption.** The park entry keeps the connection's worktree hold; `load_session` of a parked session hands it to the new connection (released on its close or shutdown), and the park timeout releases it when nobody came back. Before, the hold stayed in the in-use map forever after the adopting connection closed.
223. **Desktop rpc wiring.** `rpc.ts` wires its bridge listeners once per bridge object instead of once per process, so test files can use their own stand-in bridge.

## Final gap wave: harness

224. **Attribution and license.** `NOTICE` and a README "Attribution" section state that the wire protocol shapes are adapted from the Apache-2.0 licensed `@factory/droid-sdk` 0.10.0 type definitions; this is the only place that package name appears. The repo had no LICENSE and its README states no license for Rigwell, so none was added: choosing one is the owner's decision.
225. **RecommendMission.** Tool `RecommendMission {reason}`, offered at the top level in both tool modes only when a client can answer, the session is not a subagent, the mode is `auto` (not spec, not mission) and the connection has the missions module's `enter_mission_mode`. It asks with confirmation type `recommend_mission` (details `{reason}`, options proceed_once / cancel). On approval the connection calls the same `enter_mission_mode` path (without `continue`); a failed readiness check tells the model the user accepted but the folder is not ready. Declining returns the user's comment and the session carries on. It never runs in a Script.
226. **UpgradeModel.** Settings `modelUpgradePath: [modelId, ...]` (weaker to stronger). Tool `UpgradeModel {reason}` is offered when a client can answer and the path has a known model after the current one (the first known entry when the current model is not on the path). It asks with confirmation type `upgrade_model` (details `{reason, fromModelId, toModelId}`); on approval `updateSettings({modelId})` runs, which already queues the tool-mode notice when the new model changes the tool mode, and the next request uses the new model. The tool disappears once the path is used up. Subagents never get it.
227. **Session index.** `$RIGWELL_HOME/cache/session-index/index.db` (WAL, plus `.metadata_never_index`), bun:sqlite. Migrations are `src/storage/migrations/NNN_name.sql`, applied in order, each recorded in `schema_migrations(version, name, checksum, applied_at)` with a SHA-256 of the file; plain CREATE statements (no IF NOT EXISTS); a changed checksum throws `SessionIndexError`. Tables `meta`, `sessions` (the 12.1 columns plus `pinned`, `preview` for the first visible user text and `transcript_path`) and `session_ingest` (12.1 columns plus `settings_size`). Ingest reads only the bytes after `transcript_offset`, never past the last newline, restarts from 0 when the file shrank, and re-reads the settings file when its mtime or size changed (title, tags as `{"subagent":1}`, `archivedAt`, `pinned`, worktree). `has_user_visible_messages` is NULL until a complete line was read, then 0 or 1. Picker query: `project_key = slug(cwd)` (all keys without a cwd), subagent tag hidden, only 0 hides, pinned first, then `last_event_at` descending (the last record timestamp, else the file mtime). `list_sessions`, `rigwell -r` and the TUI list go through `listSessionEntries`, which refreshes the index (one readdir and stat per file, nothing read when unchanged) and falls back to the old file scan (`scanSessionEntries`) when the database cannot be opened, migrated or queried. Delete the folder to rebuild. Spans, bloom filters, vectors and triggers are not built.
228. **Credential store.** `src/storage/credentials.ts`. Order: macOS `security` (service `rigwell`, account = the name), Linux `secret-tool` (libsecret; the value goes over stdin), then `$RIGWELL_HOME/credentials.json` with mode 0600. The macOS `add-generic-password -w` form passes the value as an argument for an instant (the tool offers no stdin form). A keychain that is missing or refuses falls through to the file. `RIGWELL_CREDENTIALS=file` skips the keychains. Settings reference a stored key as `apiKey: "keychain:<name>"` (custom models); a plain `apiKey` or `${ENV}` still works; an unknown name makes that model invalid with a message naming the command. Lookups are cached for 30 s because they run a program. `rigwell credential set <name>` (value on stdin) and `rigwell credential delete <name>` manage them.
229. **Protocol completeness.** `update_session_settings` takes `tags` (replaces the list, validated `{name, metadata?: {string: string}}`) and the four tool id lists (a list replaces the stored one, `null` clears it); both are saved and restored. `initialize_session` takes `tags`. `list_tools` swaps the given `modelId`, `interactionMode`, `autonomyLevel`, `specModeModelId`, `skipPermissionsUnsafe`, `depth` and tool id lists in for one synchronous computation and restores them; it lists every tool the session could offer at full autonomy in direct mode, with `currentlyAllowed` true only when the tool is offered now (directly or through a Script) and not removed by `disabledToolIds`; `restrictToolIds` still hides the rest; `source` is `mcp` for MCP tools and `native` otherwise. `load_session` takes `loadAllMessages` and `messageLimit` (newest N visible messages) and returns `hasOlderMessages`; without either the whole list is returned, so existing clients see no change. `gitRepo {owner?, repoName}` in the initialize and load results comes from `git config remote.origin.url` (https, ssh, scp-style and path forms); absent without an origin.
230. **Protocol version.** Majors are compared on every incoming message with a `protocolVersion`; a missing or unreadable version is tolerated, minor and patch differences are allowed. A request with another major is answered with `-32600` "Protocol version mismatch" and `data {localProtocolVersion, peerProtocolVersion, messageType, method?, requestId?}` and is not run; a response with another major rejects the waiting request with the same error; a notification is logged and dropped.
231. **session_process_exited {message, timestamp}.** Sessions here run inside the daemon (or the `exec` process), so the processes that can die on their own are the Script sandbox runner and mission worker sessions. A Script runner that exits before the program finished (not stopped, not timed out) sends the notification on the session and the Script fails as before. A mission worker that ends with status `error` sends it on the orchestrator's connection with an extra `workerSessionId`. The daemon does not spawn `exec` children, so there is no third case. The mission case has no test of its own (a worker cannot be made to crash from outside).
232. **SessionStart hook input.** `previous_session_id` is the fork parent of a resumed session, else the session's own id on resume, and absent on startup and compact; `calling_session_id` is set when `initialize_session` is given `callingSessionId` (also written to `session_start`) and is restored on load.
233. **model_content.** A tool result longer than 120,000 characters (settings `toolResultModelChars`) is cut for the model: 60 percent head, 40 percent tail, with a line saying how many characters were left out. The transcript keeps the full `content` and writes the short text as `model_content`; clients get the full text in the `tool_result` notification; requests use `model_content` when present. Results inside a Script are not cut (the Script has its own caps).
234. **Routed turns and tool mode model.** Assistant messages of an `auto` session carry `routerId: "auto"` in the transcript. The settings file records `toolExecutionModeModelId`, the model (the routed pick for `auto`) the tool mode was worked out for.
235. **Streaming and idle notifications.** `tool_execution_phase_changed` with phase `streaming_input` goes out when the model starts a tool call, before `queued`. `agent_working_state_changed {newState: "idle"}` carries `backgroundWork`, the number of running background jobs (Execute, Task, Script); the one sent by `close_session` is after the jobs were stopped.
236. **Responses profile fields.** Model profile keys (settings `modelProfiles`, the custom model's `profile`): `textVerbosity` (low, medium, high) becomes `text.verbosity`; `serviceTier` becomes `service_tier`; `safetyIdentifier` (a string, or `true` for the session id) becomes `safety_identifier`; `extendedCache: true` becomes `prompt_cache_retention: "24h"` only when the base URL host is exactly `api.openai.com` (never Azure or a custom host). `extraArgs` still win.

## Final gap wave: clients

237. **TUI Ctrl+V.** Ctrl+V sends the effect `paste_image`; the app reads the clipboard (`src/tui/clipboard.ts`): `wl-paste`, `xclip`, `xsel` on Linux, `pngpaste` on macOS, then, as a fallback, a clipboard text that is the path (or `file://` URL) of a PNG, JPEG, GIF or WebP file. The type is read from the first bytes and the size capped at 5 MiB. The image waits in `state.images`, the input area shows `[Image #N]`, and the next non-queued message (Enter, also while a turn runs) carries them as `images[]` on `add_user_message`; the transcript line gets the same markers. A queued (Ctrl+Enter) message does not take them. No image on the clipboard says so in the transcript. Windows has no reader here. Plain text paste stays the terminal's bracketed paste.
238. **TUI Ctrl+Shift+C** copies the input box text (OSC 52) and keeps it. Terminals that report it send it as the kitty sequence `ESC[99;6u` or xterm `ESC[27;6;67~`; both parse to `ctrl+shift+c`. A terminal that sends plain Ctrl+C for it clears the input as before, which is all the terminal can tell us.
239. **SANDBOX marker.** `state.sandbox` follows `settings.sandbox.active` from `initialize_session`, `load_session` and `settings_updated`; the status bar shows `SANDBOX` after the reasoning level while it is true (not while the sandbox is enabled but unavailable).
240. **Comments and the plan editor in the TUI.** Permission, batch and spec panels: Tab opens a comment box (label "Comment", or "Add guidance for the implementation" on the spec panel); typed text goes to the box (digits included), Up/Down still pick the option, Enter sends the chosen option with `comment`, Tab or Esc closes the box (Esc again cancels, with the comment). A denial therefore sends `{selectedOption: "cancel", comment}`. On the spec panel Ctrl+G opens the plan in `$VISUAL` / `$EDITOR` (the `editor` effect with `target: "spec"`); the result replaces the panel body, selects "Edit the spec first" and Enter sends `{selectedOption: "proceed_edit", editedSpecContent, comment?}`. Choosing "Edit the spec first" before editing opens the editor instead of answering, and an empty edit is ignored. The harness appends the comment with the `[Comment]` prefix (#213).
241. **Free-text answers to AskUser.** The tool text says the user may type their own answer, so every question gets a last choice "Other...". TUI: selecting it (Enter or a number key; in a multi-select, tick it with Space and press Enter) opens a text box ("Your answer"); Enter sends the text (ticked options and the text are joined with ", " in a multi-select), Esc goes back to the options without cancelling. Desktop: an "Other..." button opens a textarea with "Send answer". SDK: nothing changes on the wire (`answer` is any string); `buildAskUserAnswer(request, replies)` builds the answer from one reply per question (an option, a list for multi-select, any other text is the free-text answer, `null` skips) and `ASK_USER_OTHER_LABEL` is the label UIs use. `send()` also takes `images` and `files`. The harness accepts any answer string, so no server change.
242. **Desktop composer attach** (spec 14.3): an Attach button (OS file picker through a hidden `<input type=file multiple>`), paste of files from the clipboard, and drop on the composer. Images (PNG, JPEG, GIF, WebP, 5 MiB) go to `images[]`, PDFs (32 MiB) and text files (1 MiB, `text/*`, or an unknown type whose bytes decode as UTF-8 without NUL) to `files[]` (text is sent as text, PDFs as base64); at most 10; refused files are named in an alert and the rest stay. Chips show a thumbnail, name and size with a remove button. An empty message with attachments sends "Attached: <names>" because `add_user_message` needs text. The transcript bubble shows `[Attached: ...]`. Home and the session screen both use it. Code: `desktop/renderer/lib/attachments.ts`, `Composer.tsx`.
243. **Desktop prompts.** Permission panels have "Add a comment" (spec panels: "Add guidance"), a textarea sent as `comment` with whatever option is clicked, cancel included. The spec panel shows "Will save to"; "Edit the spec first" turns the plan into a textarea and its button into "Approve the edited spec", which sends `proceed_edit` with `editedSpecContent`. Answers are built by `desktop/renderer/lib/prompts.ts` (`permissionAnswer`, `answerText`).
244. **Side chat storage, Promote, writes** (spec 17.4). Each fork is a session with a fresh UUID stored in `<sessions>/btw/<id>.jsonl` and `<id>.settings.json` (`src/sidepane/btw-store.ts`; its `session_start` has `parent` = the main session and `cwd`), with the tag `btw-fork` whose metadata holds `parent` and `priorExchanges` (up to 10 `{question, answer}` pairs, clipped to 1000 and 4000 characters; they are tag metadata only, so there is nothing to redact in logs because the code never logs it). The copied conversation and the fork's own turns are persisted like any session's, so the file loads with `load_session`. Entries gain `forkId` and `promotedTo`. `daemon.side_chat_promote {entryId}` waits for the fork to close (refuses while that entry is still being answered), removes the tag, moves both files into the project's session folder, sets the title to "Side chat: <first question>" and returns `{sessionId}`; promoting again returns the same id. `list_sessions` hides `btw-fork` sessions unless `includeBtwForks: true` (file scan and SQLite index both); `daemon.list_sessions` takes the same flag. `daemon.side_chat_set_writes {enabled}` (and `writes` in `side_chat_list`) is the "unless the user turns writes on" switch: off, the fork has no Edit or Create; on, it keeps them at autonomy Low, so edits run and commands that need approval are still auto-rejected; a fork already open keeps the old setting until it closes. Not done: reusing the main session's prompt-cache key (the adapters key it on the session id, and sharing the id would share sandbox and job state), and `/btw` in the TUI (not in the 13.2 v1 list, #181). Desktop: a checkbox "Allow edits in this side chat" and a "Promote to session" button on each finished answer, which opens the new session.
245. **Per-window zoom** (spec 14.4, 19.4). Each window has a slot (the lowest free number); `<home>/window-zoom.json` maps slot to level (`desktop/main/window-zoom.ts`). A new window starts from its slot's saved level, else `windowZoomLevel`. The View menu has its own Zoom In, Zoom Out and Actual Size (ids `zoom-in`, `zoom-out`, `zoom-reset`), acting on the focused window, and Ctrl+wheel zooms the window it happens in; each saves its slot. A saved 0 is kept, so a reset window does not fall back to the app-wide level. Chromium also remembers zoom per URL and a `file:` page's route is part of its URL, so the window's own level is applied again after every in-page navigation; without that a route change picked up another route's level.
246. **Archive Project** (spec 14.3). The project's row menu in the sidebar has "Archive Project": after a confirmation it archives every non-archived, non-subagent session of that folder with `archive_session`, one short connection each, and shows how many. The sessions leave the sidebar and stay in Session Management.
247. **Edits outside the client folders:** `src/storage/session-list.ts` and `src/storage/session-index.ts` (`includeBtwForks` option, default hide) and one parameter in `src/daemon/connection.ts` (`list_sessions` passes `includeBtwForks`). No new protocol methods besides the `daemon.side_chat_*` ones in `src/sidepane`.
248. **Older notes.** Entries that later work made stale carry "(Superseded by #N.)" at their end instead of being removed. Besides the ones asked for, #53, #97, #101, #127, #140, #169 and #219 were checked against the code and marked too.

## Wave 3: ops

249. **Session search storage** (spec 12.1). Migration `002_search.sql` adds `session_spans`, `session_term_filters`, the `span_tail_*` ingest columns, the `vector_epoch` meta row and triggers. One span per message chunk (at most 1200 characters, split at paragraph, line, then word), holding user and assistant text blocks only: system-reminder blocks are removed, `llm_only`/`user_only` messages and `context-` records are skipped, tool blocks are not indexed. `line_start`/`line_end` are the 1-based `.jsonl` line, event ids are the message id. `INGEST_SCHEMA_VERSION` is 2, so existing rows are read again once to build spans. Triggers: three (insert, update of text or position, delete) bump `vector_epoch`; writing a vector does not. `sessions_settings_rewritten` (settings_write_seq changed) and `sessions_daemon_fields_stale` (org_id or artifacts changed) set the ingest row's settings stamp to -1 so the settings file is read again. `meta.last_full_refresh_at` and `last_full_refresh_schema_version` are written by a full refresh; `last_integrity_check_at` is not written (no integrity check exists).
250. **Lexical search.** Words are lowercased letter/digit runs. The bloom filter holds each word and its prefixes of length 2 to 10 (4 hashes, sized at 10 bits per term); a query word longer than 10 characters is probed by its 10-character prefix. A session whose filter lacks any query word is skipped without reading spans; otherwise every query word must start a word in the same span. Result: the best span per session, scored by matches (exact words count extra), ties by recency. Lexical search includes subagent sessions; semantic leaves them out (spec).
251. **Semantic search and the embedder.** `Embedder {space, dims, embed()}` is pluggable (`setDefaultEmbedder`, or `embedder` per call). The shipped `HashingEmbedder` (256 dims) hashes word unigrams, bigrams and character trigrams into signed buckets: lexical quality with some word-form tolerance, not a neural model, and works offline. Vectors are int8 with a per-span `scale` (max/127); the query is scored by cosine against vectors whose `embedding_space` equals the embedder's space, and spans in another space are recomputed (`embedPendingSpans`, run before each semantic query). A neural model needs a real Embedder implementation; none is bundled and nothing is downloaded. The spec's `session_index_search` feature flag is not checked, because no feature-flag mechanism exists in settings; `rigwell.search_sessions` and `rigwell sessions search` are always on.
252. **Protocol and CLI.** `rigwell.search_sessions {query, mode: "lexical"|"semantic" (default lexical), limit (default 20), cwd?, includeArchived?}` returns `{hits: [{sessionId, title, cwd, spanIndex, lineStart, lineEnd, firstEventId, lastEventId, snippet, score}]}`; no file-scan fallback exists for search, so an unusable index returns an error. `rigwell sessions search <query> [--semantic] [--limit n] [--cwd dir] [--json]`.
253. **Windows script runner** (spec 18.3). The spec says `powershell.exe -NoProfile -NonInteractive -Command`. Rigwell writes the script to a temporary UTF-8-with-BOM `.ps1` and runs `[pwsh|powershell.exe] -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <ps1>`: `-Command` breaks multi-line scripts and quoting, and the default execution policy blocks `-File`. The wrapper sets `$ErrorActionPreference = 'Stop'` and re-raises the exit code of a failing native command. Env: secrets stripped with names compared case-insensitively, `Path` left as inherited (no login shell), `REPO_ROOT_PATH` added. A timeout runs `taskkill /PID <pid> /T /F` and then kills the process. Only unit-tested through an injectable spawner (`runScript({platform, spawner, which})`); never run on Windows. The Windows wake-lock PowerShell loop (spec 15.6) already exists in `src/missions/wakelock.ts`, and the desktop `--parent-pid` liveness belongs to `desktop/`; neither was changed.
254. **Open-PR auto-delete blocker skipped.** As the spec says without `create_pr`, the "open PR blocks auto-delete" rule is not built.

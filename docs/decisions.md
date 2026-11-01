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
    `index.yaml` / `lastUsedProfileId` and "deleted profiles keep name + cleanup script" are not built.
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
    Windows PowerShell runner, PR status and `create_pr`.

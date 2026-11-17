# Local decisions for unresolved specification observations

Decision 364 settles the implementation choices left by the source analysis in specification sections 10 and 20.1.
The original observations remain in the specification as historical evidence. The choices below describe Rigwell;
they make no new claim about another application's behavior. They do not replace real adapter, comparison,
long-session or installed-platform acceptance. Those outcomes remain separately tracked in PARITY and HANDOFF.

## Protocol and session lifecycle

| Unresolved observation | Rigwell decision and owning source |
| --- | --- |
| Live permission, question, picker and permission-resolved traffic was not captured | Use the documented SDK-shaped requests and notifications, with real request IDs. Exercise them with the fake-provider protocol and desktop suites. `src/daemon/connection.ts`, `src/agent/session.ts`. |
| Live interrupt traffic and settled tool phases were not captured | Interrupt aborts the owned turn and resolves its pending prompts as cancelled. Emit tool phases for actual transitions and preserve errors/cancellation rather than reporting success. `src/agent/session.ts`. |
| Compaction, retries, heartbeats, hook and error notification captures were missing | Retain the specified event schemas and emit them from the corresponding operations. Historical missing captures do not justify omitting events. `src/agent/session.ts`, `src/adapters/retry.ts`. |
| Server-side `warmup_cache` behavior | Use the existing prefix-priming request, output cap 16, without adding the throwaway answer to the conversation or monitored normal request chain. Decisions 118 and 279; `src/agent/request.ts`. |
| How to answer a prompt restored by `load_session` | `answer_request` takes the restored request ID and answer. Reject an unknown or already settled ID. `src/daemon/connection.ts`, SDK reconnect acceptance. |
| Use of `CONFLICT` | Use it for state conflicts such as a running fork, stale file fingerprint and stale rewind, rather than inventing a new error code. `src/daemon/connection.ts`, `src/sidepane/files.ts`. |
| Meaning of `backgroundWork` | The count of this session's running background jobs, attached to idle state notifications. Decision 235; `Session.backgroundWork()`. |
| Session ID on session-scoped requests | One owning session per connection. Daemon control methods that explicitly name a session retain their documented ID fields; do not add a universal routing field. `src/daemon/connection.ts`. |
| Settings fixed at session start or editable later | Keep the implemented `update_session_settings` path, including validation and settings-updated notification. An existing session is not silently reconstructed for an ordinary settings change. `src/daemon/connection.ts`. |

## Storage, instructions, skills and hooks

| Unresolved observation | Rigwell decision and owning source |
| --- | --- |
| Real `compaction_state` records were not found | Write and load the defined transcript record, including the local fields needed for exact context restoration. `src/storage/transcript.ts`. Real 200-turn behavior remains item 14. |
| Separate `session_annotations` database was absent | Use the documented transcript/settings metadata and the derived session index. Do not create an extra database merely to reproduce an unobserved internal migration. `src/storage/session-settings.ts`, `src/storage/session-index.ts`. |
| Continue-last shortcut | `--resume` without an ID lists available sessions; an explicit ID resumes one. Do not guess which session the user intended. `src/cli/main.ts`. |
| Previous-version `.bak` rule | Back up the existing settings only when it parses, then write a temporary file and rename it. A corrupt primary must not overwrite a good backup. `src/storage/session-settings.ts`. |
| Per-file AGENTS limit | Retain the specified 80,000-character total and 40,000-character lazy-pass budgets. No additional undocumented per-file cap. `src/instructions/instructions.ts`. |
| Other application's credential-file format | Do not depend on it or import subscription tokens from it. Use Rigwell's credential backend and configured OAuth clients. `src/storage/credentials.ts`, `src/auth/`. Windows native keychain acceptance remains part of release work. |
| SessionStart sources beyond observed startup/resume/compact | Emit startup, resume and compact for those actual lifecycle transitions. Hook input may tolerate additional strings; do not invent a clear transition or emit it speculatively. `src/hooks/runner.ts`, `src/agent/session.ts`. |
| Stop-hook blocking text, role and continuation cap | Feed the original local wrapper and reason back as an LLM-only user reminder. Keep the specified no-cap policy and `stop_hook_active` signal; ordinary abort/watchdog controls still apply. Decision 147; `src/agent/session.ts`. |
| Child transcript path | Use the normal session store and parent/root linkage, not a guessed external path pattern. `src/subagents/task.ts`, `src/storage/transcript.ts`. |
| Moving a running foreground Task into the background | `background` is chosen when starting Task. No unspecified foreground-to-background transfer control is added. TaskOutput/TaskStop operate on an existing background job. `src/subagents/task.ts`. |
| Skill input discrepancy | Keep `{name, args}` as the specification's design default and current public tool contract. `src/skills/`. |

## Permissions, adapters and model-side requests

| Unresolved observation | Rigwell decision and owning source |
| --- | --- |
| WebSearch / FetchUrl gating | FetchUrl asks at Off and is allowed at Low or above. WebSearch retains explicit tool permission through the normal gate; no inferred external allowlist. `src/permissions/gate.ts`. |
| Grep / Glob gating | Read-only operations are allowed at every autonomy level, matching the explicit design table. `src/permissions/gate.ts`. |
| Per-command always-allow list use | Keep explicit remembered command rules subject to safeguards and higher-priority policy. Never infer an allow rule from a previously successful command. `src/permissions/lists.ts`, `src/permissions/gate.ts`. |
| User Azure endpoint / version / deployment | Use the specified configurable OpenAI-compatible endpoint and request overrides. Do not invent an external proxy deployment map. `src/adapters/`, `src/storage/models.ts`. |
| WebSocket idle deadline | Use the configured request timeout and existing transport cancellation/retry rules. Do not copy an unobserved hosted idle limit. `src/adapters/openai-ws.ts`. |
| Spec-mode Execute restriction | Preserve the explicit prompt-based default together with the ordinary command gate. The enforced file-tool plan-directory restriction remains active. `src/permissions/gate.ts`, `src/agent/prompts.ts`. |
| Purpose of the small interactive side request | Rigwell uses its own bounded title request, with no tools, after the first visible user message unless the title is supplied/manual. Decision 211; `src/agent/session.ts`. This is a local decision, not identification of the captured request. |
| Hosted compaction/caching limits, remote allowlists and proxy deadline values | Rigwell has no vendor-hosted model pool. Apply local model limits/profiles, configured caching and request deadlines. External hosted-only values are not applicable under section 20.25. Real local/API compaction and cache behavior still require items 9 and 14. |
| Exact deferred-tool feature-flag behavior | Retain local explicit direct/Script mode and deferred-tool registration/loading rules. No hidden remote flag controls the tool set. `src/agent/deferred.ts`, `src/agent/profiles.ts`. |
| Benchmark and credit claims | No conclusion by design decision. Measure shared tasks, models and three trials with the item 11 runner, then tune only from measured results under item 12. Reference-patch and fake-service passes are not quality scores. |

## Missions, desktop, terminal and worktrees

| Unresolved observation | Rigwell decision and owning source |
| --- | --- |
| Mission folder root | `$RIGWELL_HOME/missions/<orchestrator-session-id>/`. `src/missions/store.ts`. |
| Mission role tool filtering | Orchestrators receive the four orchestrator mission tools; workers receive EndFeatureRun, which checks current-worker ownership. Core tools retain mission file protection. `src/missions/index.ts`, `src/missions/tools.ts`. |
| Mission start confirmation and unopened plan/worker/validation screens | Use the normal user permission channel for start and the local Missions page for plan, state, worker and validation information. No unattended confirmation. `src/missions/tools.ts`, `desktop/renderer/components/Missions.tsx`. |
| Automation failure count | Three consecutive final failures after retry cause auto-pause; success resets the count. Decision 188; `src/automations/manager.ts`. |
| Desktop Ctrl+N ambiguity | New Session is the desktop command; terminal Ctrl+N cycles models. Keep the specified separation. `desktop/main/main.ts`, `src/tui/reducer.ts`. |
| Ctrl+L cycling, wrapping and cap | TUI cycles permitted levels from Off through High and wraps inside the configured ceiling. Desktop composer cycles its Low/Medium/High list; ordinary daemon policy still enforces a ceiling. `src/tui/reducer.ts`, `desktop/renderer/components/Composer.tsx`. |
| Platform mapping to Ctrl+T | Keep the documented Rigwell bindings rather than add an unverified platform alias. Shift+Tab toggles Spec mode. `src/tui/keys.ts`, desktop composer. |
| Custom status-line stdin | The local JSON contract includes session ID, cwd, version, model, mode, autonomy, reasoning, running and context counters. Decision 175; `src/tui/attention.ts`. |
| Viewer internals and possible office-preview libraries | Use the specified local code/Markdown/image preview minimum. Semantic and PR review are implemented separately under item 8. Do not add office document editing based on an unverified dependency. `desktop/renderer/components/FilesTab.tsx`. |
| Theme file format | Import/export JSON color tokens per theme, with existing validation and appearance controls. `desktop/main/appearance.ts`, desktop appearance settings. |
| Toast for the visible session | Suppress when its window is focused on that session; other notifications retain their normal behavior. `desktop/main/alerts.ts`, `desktop/main/main.ts`. |
| IPC sender validation | Every registered handler goes through the trusted top-frame guard before its action. Preserve that rule for future handlers. `desktop/main/main.ts`, `desktop/main/security.ts`. |
| Side-chat starts fresh or forks | Fork from the main session's last settled prefix, with independent state and read-only tools until writes are enabled; persist/promote through the existing side-chat store. Decision 244; `src/sidepane/sidechat.ts`. |
| Terminal per-session limit | No additional undocumented count limit. Keep ownership, disconnect grace, orphan sweep and bounded scrollback. Windows currently uses the documented pipe fallback, whose installed behavior is a release acceptance limit. `src/sidepane/pty.ts`. |
| Setup shell on macOS/Linux | bash when available, otherwise sh, with sanitized environment and login PATH. Windows uses the PowerShell script-file path. `src/worktree/scripts.ts`. |
| OSC 9;4 trigger | Working emits indeterminate, pending input emits waiting, idle/exit clears progress. It does not imply a percentage estimate. `src/tui/attention.ts`, `src/tui/app.ts`. |

The source analysis's open behavior choices are settled by this record. Real performance, every-adapter smoke,
200-turn sessions, registered provider clients, native hardware and signed-install/update outcomes remain subject
to their original acceptance requirements. The two instrumented intermittent CI failures remain unresolved in
HANDOFF; this document does not claim to fix them.

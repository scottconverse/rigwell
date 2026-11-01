# Rigwell build spec: a model-independent coding-agent harness

Your own version of what Factory describes in "Droid 1.0: Building a Frontier Harness"
(https://factory.com/news/frontier-harness, published Oct 29 2026).

Product name: **Rigwell** (chosen Nov 1 2026). For short, this spec calls its engine **the harness**.
Do not reuse "Droid" or Factory branding (§11).

---

## 0. Where each fact comes from

| Tag | Meaning |
| --- | --- |
| **[POST]** | Stated in Factory's article. Vendor claim; not independently verified. |
| **[SDK]** | Seen in Factory's shipped `@factory/droid-sdk@0.10.0` (Apache-2.0) via REA static analysis and its type definitions. Shows the wire protocol and settings, not the internals. |
| **[CLI]** | Seen by static analysis of Factory's closed CLI binary (`droid.exe` 1.0.0, win32-x64). Observed in code, never executed; a value can still be overridden at runtime by server config. |
| **[CLI-INF]** | Inferred from that code, not directly stated by it. |
| **[RUN]** | Seen in real traffic or files from running the CLI: the offline capture runs (Linux build 1.0.0, no network, fake local model server; see below), the JSON-RPC captures in `bench-data/cli-runs/*/jsonrpc.jsonl`, and real session files under `~/.factory` and `bench-data/app-sessions`. |
| **[DESIGN]** | My choice for your build. Change freely. |
| **[LIVE]** | Server config the logged-in desktop app cached on disk (one paid account, Oct 30 2026). Values can differ per account and change at any time. |
| **[APP]** | Seen by static reading of Factory's desktop app code (`app.asar`, app 1.0.0, Electron 42.3.3). Never executed. |
| **[WALK]** | Seen on screen in the logged-in desktop app during the view-only walkthrough (Oct 31 2026; see `app-inventory.md`). |
| **[UNKNOWN]** | Not visible in any source. |

REA evidence: SDK package root SHA-256 `42c41d39…6739`; JS application graph Evidence
`ev_751255be0e902fb11cbe1a39f3cae40061ec0a629e6aa9a424136fc4a9ab1a57` (3 bundles, 160,979 AST nodes,
static only, nothing executed). Protocol facts below come from `dist/index-*.d.ts` (174k lines of Zod schemas).

**CLI analysis (Oct 30 2026).** The npm package for `droid.exe` 1.0.0 (SHA-256 `954b8ba5…62c9`) was
downloaded and never run. It is a Bun standalone executable; its embedded module table (879 modules)
was carved out and analyzed statically. It also embeds a second program, `script-runtime`
(54 MB PE x64, SHA-256 `e33ce39f…5e11`), the Script sandbox.

- REA JS analysis of the extracted modules: Evidence `ev_edb638185b8b3b308f1461a3f8ea993095895996213c55ad22cf76cd63861bc3`
  (parent `ev_b28d52fe601dded73b4afca73cf394b147f49d0dcaa153079627734e23d02765`).
- REA Rust inspection of `script-runtime`: Evidence `ev_47725a8ae95f7524a27f780c48dc74d2584b9351dbacd25c1e1b214d593f314f`
  (parent `ev_be272dbfcfd23547cebba11007fa6e83303f5c65ced208f9f57b21d7a855dfcd`).
- Constants were then read from the module source by hand. Nothing was executed, so these are the
  shipped defaults; Factory's server config can change some of them per user or model.

**Runtime capture (Oct 30 2026).** The Windows build could not be run: Windows Sandbox's App Control
policy blocks it because it is unsigned. Instead, the Linux build of the same version
(`@factory/cli-linux-x64` 1.0.0, npm integrity verified; binary SHA-256 `9c149112…2b176`) ran in a
dedicated WSL Ubuntu 24.04 distro, inside a network namespace with only loopback (an outside connection
test failed, as intended), as an unprivileged user, with Windows drive mounts off. Settings:
air-gapped mode, one custom model (`provider: anthropic`, no `maxOutputTokens`) pointed at a local fake
Anthropic server that saved every request. Command: `droid exec -m custom:mock-0 -o json "say hi"`
(default exec autonomy). No login was needed. Three scenarios: A, default flags; B, a feature-flag
snapshot putting the model on the Script-mode list; C, `compactionTokenLimit: 1000` with a second turn in
the same session to force compaction. Only structure and sizes were recorded here; no prompt text. One
leftover: switching off WSL's Windows-program launching was attempted but did not take effect. With no
Windows drives mounted, droid had no path to a Windows program to start.

**Second capture pass (Oct 30 2026)** used the same distro, lockdown and fake server. It covered:

- D: `exec --auto low|medium|high` and `--skip-permissions-unsafe`.
- E: the interactive app, driven in a pseudo-terminal at default autonomy and at `--auto high`. One run
  typed a prompt and then `/compress`, confirmed.
- F: forced compaction with a custom model that sets `maxOutputTokens: 5000`, and a repeat with it unset.
- `exec --list-tools` at each autonomy level.

Every request was saved; only structure and sizes were recorded. The app's attempts to reach its backend
failed name lookup, as intended. The distro was removed afterwards.

**Logged-in config (Oct 30 2026).** After Scott signed in to the desktop app with a paid account, the
app wrote the server's feature flags and remote config to `~/.factory/cache/feature-flags.json`, and
org policy to `~/.factory/org-managed-settings.cache.json`. The [LIVE] values below were read from those
files. No requests were made and no usage was spent. The desktop app bundles its own `droid.exe`; it
reports version 1.0.0 but has a different SHA-256 (`665d1d99…5026`) from the npm Windows build analyzed above.

The CLI's code and prompt text are proprietary. This spec describes behavior in its own words; do not
copy code or prompt text into your build.

---

## 1. What you are building

An **agent harness**: everything around the model: prompts, tools, how tool results come back, and the
loop that runs it. [POST]

Goals:

1. Works with any frontier model (Anthropic, OpenAI, OpenAI-compatible, open-weight) with per-model tuning.
2. **Programmatic tool calling (Script mode)**: the model writes a JS program that calls tools; many
   tool calls per model request.
3. Prompt-cache-friendly requests (append-only), small base prompt, tools loaded on demand.
4. Bounded autonomy: detect stuck/looping/dropped work and always have a defined next step.
5. One daemon process hosting many sessions; CLI/TUI and SDK clients talk to it over JSON-RPC.
6. (Later) An eval loop ("agent factory") that proposes and measures harness changes per model family.

**Scope: local product clone (Scott's choice, Oct 31 2026).** The build is the whole product that runs on
the user's machine, not only the harness. On top of goals 1–6 it includes:

7. **Desktop app** (§14): a desktop shell over the same daemon, with session sidebar, composer, command
   palette, settings and menus.
8. **Missions** (§15): a long task split into features and milestones, run by an orchestrator and worker
   sessions, with validation at each milestone.
9. **Local automations** (§16): saved prompts that run unattended on a **schedule** or a **local webhook**,
   with run history. Session-scoped crons too.
10. **Side pane** (§17): Files, Terminal, Browser and Side chat beside the session.
11. **Connectors via MCP**: the app's connector list is MCP servers (§5.7) with an add/auth UI in the app.
12. **Git worktrees** (§18): run a session in its own worktree and branch, with setup and cleanup.
13. **Notifications and appearance** (§19): OS notifications and sounds for "needs input" and "done";
    theme and font settings.

**Later phases (hosted parts; not in this build):** managed cloud computers / remote machines, fleet
management, org billing and members, plan usage limits and the hosted fallback ("core") model pool,
Slack and Teams delegation, cloud session sync and sharing links, the hosted inbox and email alerts,
Missions v2 "Workstreams" (§15.10).

**Not decided: needs Scott's approval before it goes in** (seen in the app, but outside the agreed scope):

- voice dictation in the composer;
- which of the 23 built-in skills to ship (§5.8 builds the skill mechanism; the content is a separate choice);
- GitHub-event and Slack-message automation triggers (they need a hosted relay or app);
- API keys, secrets and environments pages;
- which automation templates to ship, if any (§16.8).

Optional extras, each marked "ask Scott" where it appears: tray icon (§14.2), Chrome cookie import in the
browser pane (§17.3), `create_pr` and PR status (§18.6), per-automation `VISUAL.html` and the guided
"create by chatting" setup (§16.8).

Still out: PR / semantic-diff review UI, marketplace.

---

## 2. Architecture

```
 ┌──────────┐  ┌──────────┐  ┌───────────┐
 │ TUI/CLI  │  │ SDK (TS) │  │ Browser   │      clients
 └────┬─────┘  └────┬─────┘  └─────┬─────┘
      │ stdio JSON-RPC   │ WebSocket JSON-RPC
 ┌────▼─────────────────▼──────────▼─────┐
 │ Daemon (one process)                   │
 │  SessionManager ── Session × N (~20MB) │
 │   ├ AgentLoop + LoopGuards             │
 │   ├ RequestBuilder (append-only)       │
 │   ├ ModelAdapter (per provider)        │
 │   ├ ToolRegistry (core + deferred)     │
 │   ├ ScriptRuntime (sandboxed JS)       │
 │   ├ BackgroundJobs + Wake              │
 │   ├ PermissionGate + Hooks             │
 │   └ Transcript store + ResultLog       │
 │  MCPManager (servers start in parallel)│
 └────────────────────────────────────────┘
```

- **Desktop app is one more client.** It talks to the same daemon; it adds no agent logic of its own.
  The daemon also hosts the Mission runner (§15), automation scheduler (§16), terminal PTYs (§17) and
  worktree manager (§18). [DESIGN; how Factory's app connects is in §14]
- **Daemon, sessions in-process.** Factory moved from one ~350 MB process per session to shared daemon
  at ~20 MB per session. [POST] Do this from day one. [DESIGN]
- **Headless mode.** The SDK spawns `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`. [SDK]
  Mirror it: `harness exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
- **Runtime.** Factory's CLI runs on Bun 1.4.x with precompiled code. [POST] Recommend TypeScript on Bun
  for parity, or Node 24 with a bundled build. [DESIGN]

---

## 3. Wire protocol (JSON-RPC 2.0)

Modeled on Factory's protocol [SDK]; trim to an MVP.

**Client → harness (MVP):** `initialize_session`, `load_session`, `add_user_message`,
`interrupt_session`, `close_session`, `update_session_settings`, `compact_session`, `fork_session`,
`list_tools`, `list_models`, `list_mcp_servers`, `add_mcp_server`, `remove_mcp_server`,
`get_context_stats`, `warmup_cache`. (Factory also has rewind, skills, commands, MCP auth, queued-message
editing: add later.)

**Harness → client requests:** `request_permission`, `ask_user`, `pick_options`. [SDK]

**Harness → client notification `session_notification`, MVP types** [SDK names]:
`assistant_text_delta`, `assistant_text_complete`, `thinking_text_delta`, `tool_call`,
`tool_progress_update`, `tool_execution_phase_changed`, `tool_execution_heartbeat`, `tool_result`,
`droid_working_state_changed` (rename), `session_token_usage_changed`, `session_compacted`,
`llm_retry`, `permission_resolved`, `hook_execution_started/completed`, `agent_turn_completed`, `error`.

**Key enums to copy in spirit** [SDK]. They are written in PascalCase here; on the wire they are lowercase snake_case (`streaming_assistant_message`), see §3.1.2:

- Working state: `Idle | Thinking | StreamingAssistantMessage | WaitingForToolConfirmation | ExecutingTool | CompactingConversation`
- Tool lifecycle: `StreamingInput | Queued | Executing | SettledAfterExecution | SettledWithoutExecution | SettledUnknown`
- Turn completion reason: `Completed | Cancelled | PermissionRejected | Error | ProcessExit | StructuredOutputMissing | StructuredOutputInvalid | ModelUsageExhausted | ModelAuthenticationFailed | ModelRequestRejected | ModelProviderUnreachable | ModelProviderUnavailable | ModelRateLimited | PromptRejected | …`
- LLM retry reason: `Overloaded | RateLimited | Timeout | Network | EmptyResponse | Unknown`
- Error codes: standard JSON-RPC plus `-32001 auth`, `-32004 not found`, `-32005 session disconnected`, conflict code for duplicate in-flight ids.

**Session settings** [SDK fields]: `modelId`, `reasoningEffort` (`None…Max`), `interactionMode`
(`Auto | Spec`), `autonomyLevel` (`Off | Low | Medium | High`), `toolExecutionMode`
(`DirectOnly | ScriptOnly`), `allowSubagentsInScripts`, `systemPrompt` (string or
`{type:"preset", append}`), `sandbox {enabled, mode: PerCommand | WholeProcess}`,
`compactionTokenLimit`, `structuredOutputFormat {type:"json_schema", schema}`.

`toolExecutionMode`, `allowSubagentsInScripts`, `systemPrompt` and `structuredOutputFormat` are set only at `initialize_session` (`structuredOutputFormat` also at `load_session`), not by `update_session_settings`. `sandbox` is reported as status only. [SDK] Details: §3.1.5.

Settings precedence [SDK]: Org → Runtime → Folder → Project → User (plus Dynamic, BuiltIn). Details: §12.2.

### 3.1 Message shapes

This section gives the message shapes for the §3 method and notification names. It keeps the §3 MVP scope.

**Sources:**
- **[SDK]** is `@factory/droid-sdk` 0.10.0 (Apache-2.0). The schemas are in `dist/chunk-TWAVPIPS.mjs` and the client is in `dist/node.mjs`.
- **[RUN]** is the five captures in `bench-data/cli-runs/*/jsonrpc.jsonl`. They are CLI protocol 1.286.0 against a local mock model, 602 lines in total. Autonomy was `medium` with `autoRejectPermissionRequests: true`, so no permission or ask_user traffic appears in them.
- **[CLI-INF]** means inferred from the code, not observed.
- **[DESIGN]** means a recommendation for Scott's build.

#### 3.1.1 Framing

| Rule | Detail | Tag |
|---|---|---|
| Transport | The child process's stdin and stdout. Headless start: `exec --input-format stream-jsonrpc --output-format stream-jsonrpc`. | SDK |
| Framing | Newline-delimited JSON (NDJSON): one JSON object per line, ending in `\n`. There is no `Content-Length` header. | SDK, RUN |
| Writer | Serialize the object, escape U+2028 and U+2029 as ` ` and ` `, then append `\n`. One queue serializes all writes, so lines never interleave. | SDK |
| Reader | Split on LF and drop a trailing CR. A stdout line that does not start with `{` or `[` is logged as non-JSON and skipped. | SDK |
| stderr | Logging only. It is never protocol data. | SDK |
| Shutdown | The client ends stdin and waits 2 s. Then it kills the process: on Windows straight away, elsewhere with SIGTERM and then SIGKILL after 3 s more. | SDK |
| Harness rule | Write only protocol lines to stdout and send all logs to stderr. | DESIGN |

#### 3.1.2 Envelope

Every message is one JSON object.

| Field | Type | Req | Notes | Tag |
|---|---|---|---|---|
| `jsonrpc` | `"2.0"` | yes | | SDK, RUN |
| `type` | `"request"` \| `"response"` \| `"notification"` | yes | An explicit discriminator. Plain JSON-RPC does not have one. | SDK, RUN |
| `factoryApiVersion` | `"1.0.0"` | yes | A legacy constant that is always the same. | SDK, RUN |
| `factoryProtocolVersion` | string, semver | no | Each side sends its own version. In the captures the SDK sent `1.269.0` and the CLI sent `1.286.0`. Peers compare major.minor.patch to gate features. | SDK, RUN |
| `id` | string | requests and responses | A UUID v4 made by the sender of the request. A response echoes it. A response may carry `id: null` only when the request could not be read. | SDK, RUN |
| `method` | string | requests and notifications | Always prefixed `droid.`, for example `droid.initialize_session`. | SDK, RUN |
| `params` | object | no | | SDK |
| `result` / `error` | object | one of them, on a response | | SDK |
| `_meta` | object | no | Holds `traceparent` and `tracestate` (W3C trace context) and `requestAttribution`. For the SDK, attribution is `{client:"sdk", sdk:{language:"typescript"\|"python", version}}`. Other values of `client`: `web-desktop`, `web-app`, `web-workspace`, `daemon`, `cli`, `backend`. | SDK, RUN |

**Enum values on the wire are lowercase snake_case.** For example, §3 writes `StreamingAssistantMessage`, but the wire carries `streaming_assistant_message`. [SDK, RUN]

[DESIGN] For Scott's build:
- Keep the `type` discriminator and the method prefix, using the harness's own name in place of `droid.`.
- Drop `factoryApiVersion`.
- Keep a single `protocolVersion` field.

#### 3.1.3 Errors

The error object is `{code: int, message: string, data?: any}`. [SDK]

| Code | Name | When | Tag |
|---|---|---|---|
| -32700 | PARSE_ERROR | A line is not valid JSON, or a response is malformed. | SDK |
| -32600 | INVALID_REQUEST | An incoming request fails schema checks. The client replies with message "Invalid request format". | SDK |
| -32601 | METHOD_NOT_FOUND | | SDK |
| -32602 | INVALID_PARAMS | | SDK |
| -32603 | INTERNAL_ERROR | | SDK |
| -32001 | AUTHENTICATION_ERROR | | SDK |
| -32004 | ENTITY_NOT_FOUND | For example, `load_session` with an unknown id. | SDK |
| -32005 | SESSION_DISCONNECTED | | SDK |
| -32006 | CONFLICT | Defined, but no use of it was found in the SDK. §3's "duplicate in-flight id" use is a [DESIGN] choice. | SDK, DESIGN |
| -32800 | REQUEST_CANCELLED | | SDK |

**Protocol version mismatch.** The error's `data` is `{localFactoryProtocolVersion, peerFactoryProtocolVersion, messageType?, method?, requestId?}`. [SDK]

**Tolerance rules** [SDK]:
- If an incoming *request* fails to parse, the receiver still answers with an error response, so the peer is not left waiting.
- An unparseable *notification* is logged and dropped.
- An unknown enum value is tolerated. An unknown completion reason is read as `error`.
- Invalid array entries are filtered out instead of failing the whole message.

[DESIGN] Clients must ignore notification types they do not know.

#### 3.1.4 Handshake and lifecycle

There is no separate `initialize` method. The first request is `droid.initialize_session` (or `droid.load_session` to resume). [SDK, RUN]

The observed order [RUN]:
1. client → `initialize_session` request.
2. harness → a `settings_updated` notification, sent *before* the response and without a `sessionId`.
3. harness → the `initialize_session` response, with `sessionId`, `settings` and `availableModels`.
4. client → an `add_user_message` request. The response `{}` comes back at once, before any model output.
5. The turn streams as `session_notification`s and ends with `agent_turn_completed`.
6. client → `close_session {reason}`. The harness sends `droid_working_state_changed {newState:"idle"}`, then the response `{}`.
7. The client ends stdin.

**One session per process.** Session-scoped requests (`add_user_message`, `interrupt_session` and the others) carry **no `sessionId`**. The SDK tracks the current session itself. [SDK, RUN]

[DESIGN] If Scott's harness hosts many sessions in one process, either:
- add a required `sessionId` to every session-scoped request, or
- keep one connection per session.

Pick one and state it.

Notifications carry `params.sessionId` most of the time. It was missing on `settings_updated`, `mcp_status_changed` and the streamed `tool_call` updates. On `session_token_usage_changed`, the `sessionId` sits *inside* the notification object. [RUN]

[DESIGN] Always set `params.sessionId`.

#### 3.1.5 Client → harness methods (MVP)

Every method name is `droid.<name>`.

| Method | Params (summary) | Result | Timeout (SDK) | Tag |
|---|---|---|---|---|
| initialize_session | see below | see below | 60 s | SDK, RUN |
| load_session | see below | see below | 60 s | SDK |
| add_user_message | see below | `{}`, returned when the message is accepted, not when the turn ends | none | SDK, RUN |
| interrupt_session | `{}` | `{}` | 30 s | SDK |
| close_session | `{reason?: "clear"\|"logout"\|"prompt_input_exit"\|"other"}` | `{}` | 30 s | SDK, RUN |
| update_session_settings | see below | `{}` | 30 s | SDK |
| compact_session | `{customInstructions?: string, mode?: "handoff"}` | `{newSessionId: string, removedCount: number}` | 240 s | SDK |
| fork_session | `{title?: string, tags?: SessionTag[]}` | `{newSessionId: string}` | 30 s | SDK |
| list_tools | see below | `{tools: ToolInfo[]}` | 30 s | SDK |
| list_models | `{includeDisabled?: bool}` | `{models: ModelInfo[]}` | 30 s | SDK |
| list_mcp_servers | `{}` | `{servers: McpServerStatusInfo[], summary: McpStatusSummary}` | 30 s | SDK |
| add_mcp_server | see below | `{success: bool}` | 30 s | SDK |
| remove_mcp_server | `{serverName: string, settingsLevel: "user"}` | `{success: bool}` | 30 s | SDK |
| get_context_stats | `{}` | `{used, remaining, limit: number, accuracy: "exact"\|"estimated", updatedAt: ISO string}` | 30 s | SDK |
| warmup_cache | `{}` | `{}` | n/a | SDK |

`warmup_cache` is defined in the schemas, but the SDK never sends it: its `warmupCache()` builds a fake `{}` success response locally. So the CLI's server-side behaviour for it is not found. [SDK]

[DESIGN] Implement it as "send a cache-priming request for the current prefix and return `{}`".

##### initialize_session params [SDK; RUN = seen in the captures]

| Field | Type | Req | Notes |
|---|---|---|---|
| `machineId` | string | yes | The SDK sends `"default"`. [RUN] |
| `cwd` | string | yes | |
| `sessionId` | string | no | Create the session with this id. |
| `modelId` | string | no | [RUN] |
| `reasoningEffort` | `none\|dynamic\|off\|minimal\|low\|medium\|high\|xhigh\|max` | no | [RUN] |
| `interactionMode` | `auto\|spec\|agi\|mission` | no | MVP: `auto\|spec`. |
| `autonomyLevel` | `off\|low\|medium\|high` | no | [RUN] |
| `autonomyMode` | `normal\|spec\|auto-low\|auto-medium\|auto-high` | no | Deprecated. |
| `systemPrompt` | string, or `{type:"preset", preset:"droid", append: string}` | no | Must not be blank. `systemPromptOverride` (string) is the deprecated form. |
| `specModeModelId`, `specModeReasoningEffort` | string, enum | no | |
| `toolExecutionMode` | `direct_only\|script_only` | no | [RUN: the run driver injects it] |
| `allowSubagentsInScripts` | bool | no | |
| `structuredOutputFormat` | `{type:"json_schema", schema: object}` or null | no | |
| `compactionThresholdCheckEnabled` | bool | no | |
| `mcpServers` | McpServerConfig[] | no | See 3.1.8. |
| `additionalToolIds`, `enabledToolIds`, `disabledToolIds`, `restrictToolIds` | string[] | no | `restrictToolIds` is a hard allowlist. |
| `autoRejectPermissionRequests` | bool | no | Denies instead of asking. [RUN] |
| `skipPermissionsUnsafe` | bool | no | |
| `disableBuiltinSkills` | bool | no | |
| `sessionSource`, `sessionOriginHint` | enum | no | The SDK sends `sessionOriginHint:"sdk"`. |
| `tags` | `{name, metadata?: Record<string,string>}[]` | no | [RUN] |
| `title` | string | no | |

The schema also has fields beyond the MVP (worktree*, mission*, decomp*, workspaceId, organizationId, privacyLevel, mcpOAuthCallbackUri, blockOnMcpLoad, callingMetadata). [DESIGN] Leave these out.

##### initialize_session result

| Field | Type | Req | Tag |
|---|---|---|---|
| `sessionId` | string | yes | SDK, RUN |
| `hostId` | string | no | SDK, RUN |
| `session` | `{messages: Message[], title?: string}` | yes | SDK, RUN (`messages: []`) |
| `settings` | SessionSettings (below) | yes | SDK, RUN |
| `availableModels` | ModelInfo[] | no | SDK, RUN |
| `mcpServers` | McpServerConfig[] | no | SDK |
| `gitRepo` | `{owner?, repoName}` | no | SDK |

**SessionSettings** [SDK]:
- Required: `modelId` and `reasoningEffort`.
- Optional: `routedModelId`, `routedReasoningEffort`, `interactionMode`, `autonomyLevel`, `availableAutonomyLevels[]`, `specModeModelId`, `specModeReasoningEffort`, `tags`, `sandbox {enabled: bool, mode?: "per-command"|"whole-process"}`, `compactionThresholdCheckEnabled`, `toolExecutionMode`, `allowSubagentsInScripts`, `systemPrompt`, and the four tool-id lists.
- [RUN] also saw `autonomyMode` and `migrationActive`.
- [RUN] Quirk: a requested `script_only` came back as `direct_only` for the custom mock model, so a harness may override what was requested.

**ModelInfo** [SDK]:
- Fields: `id`, `displayName`, `shortDisplayName`, `modelProvider`, `supportedReasoningEfforts[]`, `defaultReasoningEffort`, `isCustom`, `noImageSupport?`, `tokenMultiplier?`, `kind?: "concrete"|"router"`, `isNew?`.
- `list_models` entries can also carry `disabled: true` together with `disabledReason`.
- [RUN] also saw `modelId`, `deprecated`, `supportsPDFs` and `usesUSBasedInference`.

##### load_session [SDK]

**Params:**
- `sessionId` is required.
- Optional fields:
  - `loadAllMessages: bool`
  - `messageLimit: positive int`
  - `mcpServers`
  - `autoRejectPermissionRequests`
  - `disableBuiltinSkills`
  - `sessionSource`
  - `sessionOriginHint`
  - `structuredOutputFormat`
  - `additionalToolIds`, `enabledToolIds` and `disabledToolIds`
- An unknown id returns error -32004.

**Result:**
- Required: `session`, `settings`.
- Optional:
  - `hasOlderMessages`
  - `isAgentLoopInProgress`
  - `workingState`
  - `pendingPermissions[]`: request_permission params plus `requestId`.
  - `pendingAskUserRequests[]`: ask_user params plus `requestId`.
  - `pendingPickOptionsRequests[]`
  - `queuedMessages[]`: add_user_message params plus `requestId`.
  - `pendingMessageRequestIds[]`
  - `cwd`
  - `updatedAt`: epoch seconds.
  - `availableModels`
  - `tokenUsage`
  - `inclusiveTokenUsage`
  - `lastCallTokenUsage`
  - `gitRepo`
  - `hostId`

The pending lists let a client that reconnects re-show prompts that have not been answered. [SDK]

[DESIGN] The answer to a re-shown prompt goes back as a fresh harness-side resolution keyed by `requestId`. The SDK's mechanism for this was not found; see 3.1.10.

##### add_user_message [SDK; RUN]

| Field | Type | Req | Notes |
|---|---|---|---|
| `text` | string | yes | [RUN] |
| `messageId` | string (UUID) | no | It becomes the user message id **and** the `turnId` on `agent_turn_completed`. [RUN] |
| `content` | (text \| image block)[], at least one | no | Rich content in place of `text`. |
| `images` | `{type:"base64", data, mediaType:"image/jpeg"\|"image/png"\|"image/gif"\|"image/webp"}[]` | no | |
| `files` | a base64 PDF `{type:"base64", mediaType:"application/pdf", data, name?, path?}` or plain text `{type:"text", mediaType:"text/plain", data, name?}`, as an array | no | |
| `queuePlacement` | `end_of_turn\|end_of_loop` | no | Used when a turn is already running. The SDK sends `end_of_turn`. [RUN] |
| `userMessageSource` | SessionOrigin enum | no | The SDK sends `"sdk"`. [RUN] |
| `outputFormat` | `{type:"json_schema", schema}` | no | |

Out of MVP scope: `imagePaths`, `skipAgentLoop`, `role`, `visibility`, `sender`, `author`, `chatSettingsCatalog`.

##### update_session_settings [SDK]

**Params** (all optional):
- `modelId`, `reasoningEffort`
- `interactionMode`, `autonomyLevel`
- `specModeModelId` and `specModeReasoningEffort` (both nullable)
- `tags`
- `compactionTokenLimit: number`
- `compactionThresholdCheckEnabled`
- the four tool-id lists

**Result:** `{}`. The new settings then arrive as a `settings_updated` notification.

**Note:** §3 lists `toolExecutionMode`, `allowSubagentsInScripts`, `systemPrompt`, `sandbox` and `structuredOutputFormat` as session settings. The SDK accepts these only at `initialize_session` (or `load_session` for `structuredOutputFormat`). It does **not** accept them on `update_session_settings`. `sandbox` appears only as status in SessionSettings. [SDK]

[DESIGN] Keep the same split, or decide on purpose that they can change mid-session.

##### list_tools [SDK]

**Params** (all optional):
- `modelId`, `interactionMode`, `autonomyLevel`, `specModeModelId`
- the four tool-id lists
- `skipPermissionsUnsafe`
- `depth: int ≥ 0`
- `includeSchemas: bool`
- `toolIds: string[]`

**Result:** `{tools: [...]}`. Each tool has these fields:
- `id`, `llmId`, `displayName`, `description`
- `category: "read"|"edit"|"execute"|"other"`
- `defaultAllowed: bool`, `currentlyAllowed: bool`
- `source?: "native"|"mcp"|"connector"`
- `schemas?: {input: JSONSchema, result?: {content, parsedContent?}, progress?}`

##### add_mcp_server [SDK]

The params are:
- `name: string`
- `type: "stdio"|"http"|"sse"`
- `url?` (http/sse)
- `headers?: Record<string,string>`
- `oauth?: false | {scopes?, resource?, authorizationServerIssuer?, clientMetadataUrl?, clientId?, clientSecret?}`
- `command?` (stdio)
- `args?: string[]`
- `env?: Record<string,string>`

#### 3.1.6 Shared sub-shapes [SDK]

| Shape | Fields |
|---|---|
| ToolUse | `type:"tool_use"`, `id`, `name`, `input: object`, `scriptExecution?: {runId, outerToolUseId}` (set on calls made from inside Script). |
| ToolResult | `type:"tool_result"`, `toolUseId`, `content?: string \| (text \| image \| document block)[]`, `isError?: bool`, `modelContent?: string`. |
| TokenUsage | `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `thinkingTokens` (all numbers), and an optional `factoryCredits`. [RUN] saw all six. |
| McpServerConfig (init/load) | stdio `{name, command, args[] (default []), env{} (default {})}`; http or sse `{type:"http"\|"sse", name, url, headers: {name, value}[], oauth?}`. |
| McpServerStatusInfo | `name`, `status: connecting\|connected\|disconnected\|failed\|disabled`, `source` (settings level), `isManaged`, `serverType`, and optionally `displayName`, `error`, `toolCount`, `requiresAuth`, `hasAuthTokens`. |
| McpStatusSummary | `total`, `connected`, `connecting`, `failed`, `disabled?`, `configError?: {path, message}`. [RUN] saw the first five. |

#### 3.1.7 Harness → client: `droid.session_notification`

The notification looks like this:

`{type:"notification", method:"droid.session_notification", params:{sessionId?: string, notification:{type: <string>, ...}}}` [SDK, RUN]

| `notification.type` | Payload fields | Tag |
|---|---|---|
| `assistant_text_delta` | `messageId`, `blockIndex: int`, `textDelta: string` | SDK, RUN |
| `assistant_text_complete` | `messageId`, `blockIndex` | SDK, RUN |
| `thinking_text_delta` | `messageId`, `blockIndex`, `textDelta` | SDK, RUN |
| `tool_call` | `toolUse: ToolUse` | SDK, RUN |
| `tool_progress_update` | `toolUseId`, `toolName`, `update: {type: "tool_call"\|"tool_result"\|"error"\|"status"\|"message", toolName?, status?, details?, text?, error?, timestamp?, parameters?, valueSnippet?, terminalId?, fullOutput?, exitCode?: int\|null, signal?: string\|null, subagentSessionId?}` | SDK, RUN |
| `tool_execution_phase_changed` | `toolUseId`, `toolName`, `phase: streaming_input\|queued\|executing\|settled_after_execution\|settled_without_execution\|settled_unknown` | SDK; RUN saw only `queued` and `executing` |
| `tool_execution_heartbeat` | `toolUseId`, `toolName`, `detached?: bool` | SDK |
| `tool_result` | the ToolResult fields plus `messageId` | SDK, RUN |
| `droid_working_state_changed` | `newState: idle\|thinking\|streaming_assistant_message\|waiting_for_tool_confirmation\|executing_tool\|compacting_conversation` | SDK, RUN |
| `session_token_usage_changed` | `sessionId`, `tokenUsage: TokenUsage`, `inclusiveTokenUsage?`, `lastCallTokenUsage?: {inputTokens, cacheReadTokens, outputTokens?}` | SDK, RUN |
| `session_compacted` | `summaryId`, `removedCount: int ≥ 0`, `visibleBoundaryMessageId: string\|null` | SDK |
| `llm_retry` | `attempt: number`, `reason: overloaded\|rate_limited\|timeout\|network\|empty_response\|unknown` | SDK |
| `permission_resolved` | `requestId` (the id of the `request_permission` request), `toolUseIds: string[]`, `selectedOption: ToolConfirmationOutcome` | SDK |
| `hook_execution_started` | `hookId`, `hookEventName`, `hookCommands: {command, timeout?}[]`, `hookMatcher?`, `hookToolCallId?`, `hookParentId?`, `hookOrder?`, `isParallelExecution?`, `parallelGroupId?` | SDK |
| `hook_execution_completed` | `hookId`, `hookStatus: "completed"\|"error"`, `hookEventName?`, `hookToolCallId?`, `hookPreventedAction?`, `hookResults?: {exitCode, stdout, stderr, command?, timeout?, suppressOutput?}[]` | SDK |
| `agent_turn_completed` | `reason`, `tokenUsage`, `turnId?`, `cumulativeTokenUsage?`, `childTokenUsage?`, `cumulativeChildTokenUsage?`, `durationMs?` (wall clock for this turn, including time spent waiting on the user) | SDK; RUN saw only `reason:"completed"` |
| `error` | `message`, `errorType: ConnectionError\|ProtocolError\|SessionError\|TimeoutError\|DroidClientError\|ProcessExitError\|Error`, `timestamp: ISO`, `exitCode?`, `error?: {name, message}` | SDK |

**Hook events** (`hookEventName`) [SDK]: `PreToolUse`, `PostToolUse`, `Notification`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd`.

**Turn completion reasons** [SDK]: `completed`, `cancelled`, `permission_rejected`, `error`, `process_exit`, `spec_handoff`, `structured_output_missing`, `structured_output_invalid`, `structured_output_schema_invalid`, `model_usage_exhausted`, `model_authentication_failed`, `model_request_rejected`, `model_provider_unreachable`, `model_provider_unavailable`, `model_rate_limited`, `prompt_rejected`, `completion_persistence_failed`, `no_approver_available`.

Behaviour seen on the wire [RUN]:
- **`tool_call` is sent more than once** for the same `toolUse.id` while the model streams the input. The `input` grows: first `{}`, then a partial input, then the full input. [DESIGN] Clients replace by id and do not append.
- **`tool_progress_update` for a shell command** has `update.type:"status"` with an incremental `text`, the running `fullOutput` and `terminalId`. `exitCode` and `signal` arrive on the last update.
- **Script mode:**
  - Inner calls come back as `tool_result` with `toolUseId` `"<runId>-N"` and `messageId` `"repl-tool-result:<runId>-N"`, and their `content` is a string.
  - The outer Script result `content` is an array of `{type:"text", text}`. Its last element is a run footer: elapsed time, call count and log path.
- **`droid_working_state_changed {newState:"idle"}`** also carried `backgroundWork: int`, which is not in the SDK schema.
- **`session_token_usage_changed`** is sent after each model call during a turn, and once more just before `agent_turn_completed`.

Other types also appear on the wire but are not in the §3 MVP list [SDK, RUN]: `create_message` (the full persisted message), `settings_updated`, `session_title_updated`, `mcp_status_changed` and `thinking_text_complete`. Clients ignore any type they do not know.

[DESIGN] The harness may also emit these, but they are not MVP requirements.

#### 3.1.8 Harness → client requests, and how to answer them

These are real JSON-RPC requests sent from the harness to the client. Each has an `id`, and the client must send a `response` with that `id`. [SDK]

##### `droid.request_permission` [SDK]

**Params:** `{toolUses: [{toolUse: ToolUse, confirmationType, details}], options: [{label: string, value: ToolConfirmationOutcome}], associatedSessionIds?: string[]}`

- **`confirmationType`** is one of: `edit`, `exec`, `create`, `apply_patch`, `mcp_tool`, `script`, `ask_user`, `sandbox_violation`, `droid_shield_violation`, `exit_spec_mode`, plus the mission types.
- **`details`** depends on the type:

| Type | `details` fields |
|---|---|
| `edit` | `filePath`, `fileName`, `oldContent?`, `newContent?` |
| `create` | `filePath`, `fileName`, `content` |
| `exec` | `fullCommand`, `command`, `extractedCommands?`, `impactLevel?`, `riskLevelReason?` |
| `mcp_tool` | `toolName`, `impactLevel`, `serverName?`, `actualToolName?` |
| `script` | `impactLevel`, `calls: [{toolName, line, column, toolInput, confirmation, alwaysAsk?}]` |

**Answer:** `result: {selectedOption, comment?, editedSpecContent?, clientStartsHandoffSession?, specHandoffId?}`
- `selectedOption` must be one of the offered `options[].value`.
- `proceed_edit` requires `editedSpecContent`.
- If the client has no handler, or its handler throws, it answers `{selectedOption:"cancel"}`.
- The harness then emits `permission_resolved`.

**ToolConfirmationOutcome values:** `proceed_once`, `proceed_always`, `proceed_always_file`, `proceed_always_tools`, `proceed_always_server`, `proceed_auto_run`, `proceed_auto_run_low|medium|high`, `proceed_new_session(_low|_medium|_high)`, `proceed_edit`, `proceed_report_false_positive`, `cancel`.

[DESIGN] The MVP harness offers only `proceed_once`, `proceed_always` and `cancel`.

##### `droid.ask_user` [SDK]

**Params:** `{toolCallId, questions: [{index (1-based), topic, question, options: string[], multiSelect?: bool}]}`

**Answer:** `{cancelled?: bool, answers: [{index, question, answer: string}]}`

If there is no handler, or the handler fails, the answer is `{cancelled: true, answers: []}`.

##### `droid.pick_options` [SDK]

**Params:** `{toolCallId, title, hint?, emptyText?, rows: [{id, label, detail?}], multi: bool, preselectedIds: string[], initialSearch?}`

**Answer:** `{cancelled?, selectedIds: string[], refresh?: bool}`

The default answer is `{cancelled: true, selectedIds: []}`. A client may instead reply with a JSON-RPC error, meaning it cannot show a picker.

While the harness waits on any of these three requests, the working state is `waiting_for_tool_confirmation`. [SDK enum; CLI-INF that it applies to all three]

[DESIGN] Do not time out on the harness side. `durationMs` on `agent_turn_completed` already counts the wait.

#### 3.1.9 Interrupt [SDK; CLI-INF outcome]

- The client sends `droid.interrupt_session` with `params: {}` and gets `{}` back. It has a 30 s timeout. There is no sessionId and no turn id: it stops whatever the current session is doing. [SDK]
- The SDK's own `session.interrupt()` is just this call. The run driver uses it as its timeout. [SDK, RUN source]
- The expected follow-up is `agent_turn_completed {reason:"cancelled"}` and then `droid_working_state_changed {newState:"idle"}`. [CLI-INF] No interrupt is present in the captures.
- [DESIGN] Pending `request_permission`, `ask_user` and `pick_options` requests should be settled as cancelled. Running tools should end with phase `settled_after_execution` or `settled_unknown`.

To stop a turn and exit, send `close_session` and then end stdin. If the process exits with code 0 after an `agent_turn_completed`, the SDK counts that as a clean exit. [SDK]

#### 3.1.10 End-to-end sequence (shape only, from `p0-script`, CLI 1.286.0) [RUN]

Times are in ms from spawn. Ids are shortened. Every message also carries the envelope fields from 3.1.2.

```text
 283 → request  droid.initialize_session  {machineId:"default", cwd, modelId, autonomyLevel:"medium",
                                            reasoningEffort:"high", sessionOriginHint:"sdk", toolExecutionMode, ...}
1013 ← notif    session_notification       {notification:{type:"settings_updated", settings:{...}}}        (no sessionId)
1018 ← response (same id)                  {sessionId:S, hostId, session:{messages:[]}, settings, availableModels}
1021 → request  droid.add_user_message     {messageId:M, text:"say hi", userMessageSource:"sdk", queuePlacement:"end_of_turn"}
1032 ← response (same id)                  {}
1094 ← notif    mcp_status_changed         {servers:[], summary:{total:0,...}}                              (no sessionId)
1109 ← notif    droid_working_state_changed {newState:"streaming_assistant_message"}
1131 ← notif    create_message             {message:{id:"context-M", role:"user", visibility:"llm_only", ...}}
1135 ← notif    create_message             {message:{id:M, role:"user", content:[{type:"text",...}]}}
1142 ← notif    session_title_updated      {title, updateType:"first_user_message"}
1150 ← notif    droid_working_state_changed {newState:"thinking"}
1168 ← notif    droid_working_state_changed {newState:"streaming_assistant_message"}
1168 ← notif    assistant_text_delta       {messageId:A, blockIndex:0, textDelta:"hi"}
1168 ← notif    assistant_text_complete    {messageId:A, blockIndex:0}
1179 ← notif    create_message             {message:{id:A, role:"assistant", content:[...]}}
1190 ← notif    session_token_usage_changed {sessionId:S, tokenUsage:{...}}                                 (sessionId inside)
1191 ← notif    agent_turn_completed       {reason:"completed", turnId:M, tokenUsage:{...}}
1191 → request  droid.close_session        {reason:"other"}
1191 ← notif    droid_working_state_changed {newState:"idle", backgroundWork:0}
1195 ← response (same id)                  {}
```

A tool turn (pilot-T1-direct) puts this between `thinking` and `agent_turn_completed`:
- `tool_call` × N, as the input grows
- `executing_tool`
- `tool_execution_phase_changed` (`queued`, then `executing`)
- `tool_progress_update` × N
- `tool_result`
- back to `thinking` or `streaming_assistant_message` [RUN]

---

## 4. Agent loop

```
loop:
  req = RequestBuilder.next(session)        # append-only
  stream = ModelAdapter.send(req)           # stream deltas to client
  guard.onStream(stream)                    # silence / partial handling
  if no tool calls: complete turn (unless a background job is pending → sleep)
  for each tool call: Hooks(PreToolUse) → PermissionGate → execute → Hooks(PostToolUse)   # order: §5.6
  append results (size-budgeted) → guard.onTurn() → continue
```

### 4.1 Per-model profiles [POST, DESIGN shape]

Each supported model gets a profile file:

```ts
interface ModelProfile {
  id: string; provider: 'anthropic'|'openai'|'openai-compat'|'google'|'bedrock';
  toolExecutionMode: 'direct_only'|'script_only';   // Script on by default for strong models
  promptVariant: string;                             // system-prompt overlay
  toolDescriptionOverrides: Record<string,string>;
  readLineNumbers: 'always'|'on_request';            // see §5.4
  reasoningField?: 'reasoning'|'reasoning_content';  // OpenAI-compat wire quirk [SDK]
  cache: { strategy: 'anthropic-breakpoints'|'openai-auto'|'none' };
}
```

Factory turns Script mode on by default only for the strongest models. [POST] How: the CLI reads a
server-side allowlist (remote config key `script_tool_models`). A model on the list runs `script_only`;
every other model runs `direct_only`; a per-session setting can override. [CLI] When the model changes
mid-session, the harness adds a notice message explaining the new mode. [CLI]

Live allowlist [LIVE]: 12 model IDs. They are the top tiers of 3 vendors' frontier lines (several with a
"fast" variant) plus one open-weight model. No mid-tier or small model is on it. That matches the post's
"strongest models only".

Design: ship a profile per model you support, plus a conservative default (`direct_only`). Keep the
allowlist in config, not code, so you can turn Script on for a model without a release. [DESIGN]

### 4.2 Bounded autonomy: loop guards

| Condition | Action | Source |
| --- | --- | --- |
| Stream silent 4 min | Treat as dropped; retry (a retryable idle-timeout error). In the CLI the 240,000 ms idle limit applies to the vendor's own hosted Anthropic stream; custom/BYOK models and the OpenAI WebSocket path use the user's `llmRequestTimeout` setting instead (default 10 min) | POST + CLI |
| Response hits hard time limit | Max 2 attempts. Default limit 10 min (600,000 ms); the server can set it per response via a header. Only the first cut is retried, and only if it came within limit + 60 s | POST + CLI |
| Response breaks mid-stream | Discard the partial message, then retry (model only builds on complete answers) | POST |
| Retry after error | Send to the same provider/region that holds the cache | POST |
| No visible output | Inject a one-word "continue" message each time; stop at 3 in a row | POST + CLI (`3`) |
| Same tool calls repeated (same names + same arguments, as one batch) | Nudge at 3 repeats, stop at 6 with reason "repeated identical tool calls" | POST + CLI (`3`, `6`) |
| Repeats are only waits on a running Script | No nudge; stop at 24 repeats (2 h ÷ 5-min wait window) | CLI |
| Identical calls that return *new* results (polling a build) | Allowed | POST; CLI hashes each batch's results too [CLI-INF] |
| Model output cycles (the same text repeating) | Error with cycle length and repeat count | CLI (class exists; thresholds not read) |
| Todo list left incomplete at turn end | Nudge | CLI |
| Context near limit | Compact; reserve 16,000 tokens for the summary, ask for about 4,000 (§4.4) | POST + CLI |

Rules live in the loop, not the prompt, so every model gets them. [POST] The CLI confirms this: the
counters and nudges are in the agent-loop module, not the prompt. [CLI]

Design: make every threshold a config value with these defaults, and give "waiting on my own
background job" its own, higher limit so long jobs are not killed as loops. [DESIGN]

### 4.3 Background work and wake [POST]

- Long shell commands, subagents, and Scripts can run in the background.
- The model may end its turn ("sleep") while work runs; the harness injects a reminder message and
  resumes the loop when the job finishes. No polling requests.

### 4.4 Compaction

Trigger at `compactionTokenLimit` or a model-specific threshold. Summarize within a 16k-token reserve (budget below), keep the
system prompt + tool block byte-identical, then continue append-only from the summary. [POST + DESIGN]

The CLI's saved compaction record holds the summary text, its token count, the number of messages
removed, and the list of deferred tools that were loaded, so loaded tools stay loaded after
compaction. A separate compaction model can be set per session. [CLI] Do the same. [DESIGN]

Summary budget in the CLI [CLI]:

| Value | Default | Meaning |
| --- | --- | --- |
| Summary reserve | 16,000 tokens | Room kept free for the summary; also the starting value for the summarizer's output limit (capped for custom models, below). When compacting because the context is full, the reserve grows by the size of items carried over (todos, other carried session context) |
| Custom-model summarizer cap | 8,000 tokens | For a custom model, the summarizer's output limit is the smaller of the reserve and the model's `maxOutputTokens`; if `maxOutputTokens` is unset, the smaller of the reserve and 8,000 |
| Text headroom | 8,192 tokens | Added on top of a requested output limit at the request layer when the call expects text and reasoning is not off (always for custom models). The result is capped at the model's own output ceiling |
| Summary soft cap | 4,000 tokens | Target length given to the summarizer in its instructions |
| Post-compaction ceiling | 40,000 tokens | Upper bound for what is kept after a context-limit compaction |

No caller in the bundle overrides these defaults. So the post's "16k" is the reserve and output ceiling,
not the expected summary length. Design: same three values as config, defaults 16k / 4k / 40k. [DESIGN]

Observed compaction requests [RUN], with the arithmetic checked against the code [CLI]:

| Case | Summarizer limit (logged) | Request `max_tokens` |
| --- | --- | --- |
| Custom model, no `maxOutputTokens` (automatic and manual `/compress`) | 8,000 (cap) | **16,192** = 8,000 + 8,192 headroom |
| Custom model, `maxOutputTokens: 5000` | 5,000 | **5,000** (headroom cut off by the model's 5,000 ceiling; every main request in that session was also 5,000) |
| Vendor-hosted model (no cap) | not captured | not captured; by the code, 16,000+ reserve + 8,192, capped at the model's output ceiling |

An earlier reading of 16,192 as "16,000 reserve + 192 carried context" was wrong; the code and the 5,000
run show it is the 8,000 cap plus the headroom.

Manual compaction (`/compress` in the interactive app) [RUN] asks for confirmation and says the visible
conversation is kept. It is logged as `reason: manual`, and it sends the same summarizer request as
automatic compaction. The summarizer request had one system block of about 2,300 characters (summarizer instructions with a fixed section outline),
no tools, and one user message wrapping the old conversation in a code fence. Bulky reminder blocks were
replaced by an "omitted at compaction boundary" marker. The next request opened with the summary,
framed as written by a previous instance, plus a note that files it mentions must be re-read. That was
followed by the re-injected context, the recent turns kept verbatim, and the new prompt. The system
block and tools were unchanged.

Design: the same chain as config. The summary limit is the reserve, capped per model. Add text headroom
at the request layer, then clamp to the model's output ceiling. Log the final number. [DESIGN]

### 4.5 Automatic model routing [CLI]

The CLI's "auto" model (the router) is chosen **on the client**, per request, by a small classifier
model:

1. Build a classifier input from the session: turn context, the last 6 messages and last 8 tool calls,
   in priority order within a 16,000-token budget (tokens estimated as characters ÷ 4; long text cut to
   its first and last 2,000 characters).
2. A small, cheap model (low reasoning effort, 8,192 max output tokens, 10 s timeout) returns a 0–1
   fitness score for each candidate model, plus a label and a reason, as JSON. Malformed JSON is
   recovered where possible. If the request has images, models without image input score 0.
3. Pick the **cheapest** candidate (by relative input cost) whose score is at least 0.7; ties go to
   the higher score. The other candidates become fallbacks, ordered by score, used when the chosen
   model's provider errors.
4. If none reaches 0.7, pick the highest score. If every score is 0, use the first candidate.
5. Record a reason: org policy (one candidate), vision required, hard (best score below 0.7), routine
   (at least 75% of candidates qualify), or task fit.

Candidates: a default list of 7 models across several vendors, replaceable by remote config. In the live
config the remote candidate list is empty, so the built-in 7 apply. Router visibility is "off for
everyone" and the `auto_provider_routing` flag is off [LIVE]. Only an
organization admin can set the candidate list, routing rules and routing guidance; values set at user
or project level are ignored. Each candidate carries a one-line description the classifier reads. The
routed model is cleared after compaction, so routing runs again. A "model upgrade" tool lets the agent
ask for a stronger model mid-session.

Design: implement the same rule (cheapest model that clears a quality bar, with score-ordered
fallbacks). Make the bar, the classifier model, and the candidate list config. [DESIGN]

### 4.6 OpenAI and other provider adapters

#### 4.6.1 Which wire API

| Model kind | Wire API | Source |
| --- | --- | --- |
| Built-in OpenAI models (`gpt-5.x`, `gpt-6-*`) | **Responses API**, streamed. Sent over WebSocket when available (4.6.3), otherwise HTTP SSE | [CLI] |
| Custom model, `provider: "openai"` | Responses API ("OpenAI Responses API") | [CLI] |
| Custom model, `provider: "generic-chat-completion-api"` | **Chat Completions**, streamed ("OpenAI-compatible") | [CLI] |
| Custom model, `provider: "anthropic"` | Anthropic Messages | [CLI] |
| Custom model, `provider: "bedrock-converse"` | AWS Bedrock ConverseStream | [CLI] |

- The vendor proxy routes each api-provider to one path family [CLI]:
  - OpenAI-family: `/api/llm/o/v1/responses`;
  - Chat Completions: `/api/llm/o/v1/chat/completions`;
  - Anthropic: `/api/llm/a/v1/messages`;
  - Google: `/api/llm/g/v1/generate`.
- This harness has no proxy, so it calls providers directly. Keep a per-api-provider *profile table* like the CLI's (4.6.6). [DESIGN]

#### 4.6.2 Responses request (HTTP)

Built per turn [CLI]:

| Field | Value |
| --- | --- |
| `model` | Model id |
| `input` | Transcript as Responses items (messages, `function_call`/`function_call_output`, `custom_tool_call`/output, `reasoning`) |
| `instructions` | System blocks joined with blank lines |
| `tools` | See 4.6.4 |
| `stream` | `true` |
| `store` | **`false`**. The server keeps no state, so the full input is sent every turn |
| `include` | `["reasoning.encrypted_content"]` when reasoning is on |
| `reasoning` | `{effort, summary: "auto"}`. Left out when effort is `off`, `none` or `dynamic`. Exception: `{effort:"none"}` is sent for models that accept `none`. xAI gets no `summary` |
| `parallel_tool_calls` | `true` unless the model profile says otherwise |
| `tool_choice` | `"auto"` for OpenAI-made models |
| `max_output_tokens` | Left out for built-in OpenAI models. For custom models it is set and clamped to the model's maximum |
| `prompt_cache_key` | See 4.6.5 |
| `prompt_cache_retention` | `"24h"`, only when talking to OpenAI itself (not Azure, not custom) and the model profile has extended cache |
| `text.verbosity` | Taken from the model profile when set |
| `service_tier` | Taken from the model profile when set |
| `safety_identifier` | Taken from the model profile when set (user or session id) |
| Custom `extraArgs` | Merged into the request last, so users can add any field |

**Reasoning effort.** Values are `none`, `dynamic`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. [SDK]
- Each model profile lists which values it supports and which is the default. [CLI]
- The effort is sent lower-cased. [CLI]

**Reasoning items** [CLI]:
- When a `reasoning` output item finishes, the harness stores four things on the assistant message: its `id`, its `encrypted_content`, and a summary (taken from the summary text, or from the reasoning text when there is no summary).
- On later turns the stored item is replayed as `{type:"reasoning", encrypted_content, summary:[{type:"summary_text", text}]}` right before that assistant turn.
- Replay only works on the provider that made the item. For that reason a session records `providerLock` / `apiProviderLock` once it has used a provider. [RUN: session settings carry `providerLock:"openai"`]
  - If the provider changes, drop the encrypted items and keep only the summary text. [DESIGN]

#### 4.6.3 WebSocket transport

| Item | Behaviour | Source |
| --- | --- | --- |
| Feature flag | `OpenAIResponsesWebSocketMode`, on by default | [CLI] |
| Api-providers that support it | `openai`, `azure_openai` | [CLI] |
| Custom model can use it directly | Only when all of these hold: provider is `openai`; the base URL is exactly OpenAI's public base; auth is a plain `apiKey` (no helper, no credential source); no Bedrock | [CLI] |
| URL | Built from `<base>/responses`, with `http`→`ws` and `https`→`wss` (the vendor proxy uses `/api/llm/o/v1/responses/ws`) | [CLI] |
| Frame sent | `{type:"response.create", ...same body as HTTP...}` | [CLI] |
| Chaining | If the new input starts with the previous turn's full context, only the new items are sent, with `previous_response_id` (mode `ws_chained`). Otherwise the full input is sent (`ws_full`). The chain resets on error or model change | [CLI] |
| Timers | Connect timeout 15 s; ping every 30 s during a turn; the idle socket closes after 180 s | [CLI] |
| Falling back | Two transport failures, or close code 1009 (message too big), turn WebSocket off for the rest of the session; HTTP is used after that | [CLI] |
| Azure | Also falls back to HTTP on `400 model_not_found`, and on `403 forbidden` with the "different inference provider" message | [CLI] |
| Frames validated | `response.created`, `response.output_item.added/done`, `response.output_text.delta`, `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`, `response.function_call_arguments.delta/done`, `response.custom_tool_call_input.delta/done`, `error`, `response.completed`, `response.incomplete`, `response.failed` | [CLI] |

v1 can ship HTTP SSE only and add WebSocket later. It is a speed feature: the chained mode saves upload, not behaviour. [DESIGN]

#### 4.6.4 Tool encoding for Responses

| Tool | Encoding | Source |
| --- | --- | --- |
| ApplyPatch | `{type:"custom", name:"ApplyPatch", format: <Lark grammar>}`: freeform text checked by a grammar. Where custom tools are unsupported: a `function` with a single `input: string` parameter (`strict:false`) | [CLI] |
| Script | `{type:"custom", name:"Script"}`: freeform text, no grammar. Where unsupported: a normal function | [CLI] |
| ToolSearch | A `function` with `strict:true`, but only for built-in models on api-provider `openai` | [CLI] |
| All others | `{type:"function", name, description, parameters: <JSON schema>, strict:false}` | [CLI] |

- Custom tools are unsupported on `google` and `xai`. Every other api-provider supports them. [CLI]
- OpenAI-made models default to the ApplyPatch file-edit profile; other models default to Create + Edit. A custom model can override this with `fileEditToolProfile`. [CLI]

#### 4.6.5 Prompt caching

- `prompt_cache_key` is always sent. [CLI]
  - When an explicit cache key exists **and** the api-provider is `openai`, `azure_openai`, `snowflake` or `bedrock_openai` **and** the model is not custom, that key is used.
  - Otherwise the **session id** is used.
- `prompt_cache_retention:"24h"` is sent only when talking to OpenAI itself. [CLI]
- Nothing else is needed: OpenAI caches the longest matching prefix on its own. Keep the system text and tool list byte-stable across turns (already in §6). [DESIGN]

#### 4.6.6 Chat Completions (OpenAI-compatible) details

**Reading reasoning.** In each streamed delta, the harness checks `reasoning` first, then `reasoning_content`. It records which field it found. [CLI]

**Sending reasoning back** [CLI]:
- On an assistant message that has tool calls, the reasoning is written back under the same field name.
- If no field was ever seen, `reasoning_content` is used (with a single space when there is no text).
- Some providers don't take reasoning history at all; for those it is left out.

**Per-provider quirks** (profile table, [CLI]):

| Api-provider | Quirk |
| --- | --- |
| `mistral` | Reasoning field `reasoning_content`. Replay is sent as `thinking` content parts. No reasoning history |
| `together` | Reasoning field `reasoning_content`. Thinking is on by default; opt-in param `reasoning.enabled`. No reasoning history |
| `baseten` | Thinking is on by default; opt-in via `chat_template_args.enable_thinking`. Effort `off`/`none` is turned into `low`. No reasoning history |
| `databricks` | On Responses, these fields are not supported: `background`, `previous_response_id`, `store` |
| `google` (via chat API) | Gemini `thought_signature` is read from `delta.extra_content.google` and replayed the same way |

- Tool schemas are sent as `{type:"function", function:{name, description, parameters}}`. [CLI-INF]
- Per-model `chatCompletionRequest` overrides are merged in this order: profile < model < api-provider-specific. [CLI]

#### 4.6.7 Custom model config

Custom (BYOK) models are configured in `customModels[]`; fields, defaults and the v1 subset are in §12.2 "Custom models (BYOK)".

#### 4.6.8 Azure OpenAI

- In the CLI, Azure is an **api-provider the vendor proxy routes to** (`azure_openai`). The user does not configure it. [CLI]
  - Recorded sessions show assistant messages tagged `apiProvider:"azure_openai"` for `gpt-6-luna`. [RUN]
- Compared with `openai`, the Azure profile differs in these ways [CLI]:
  - it has the WebSocket HTTP fallbacks listed in 4.6.3;
  - no 24 h cache retention is sent;
  - models are tested per region;
  - only the `global` region exists.
- No user-side Azure settings were found: no `api-version` and no deployment-name mapping (see Not found).
- For v1, treat Azure as a custom `openai` provider [DESIGN]:
  - `baseUrl` = `https://<resource>.openai.azure.com/openai/v1/`;
  - the key goes in the `api-key` header (or Bearer for Entra);
  - the model is the deployment name;
  - send no `prompt_cache_retention`.

#### 4.6.9 Retries (all providers)

| Strategy | Attempts | Base delay | Backoff | Source |
| --- | --- | --- | --- | --- |
| interactive | 4 (6 for 429/throttling) | 1 s | ×2 with jitter | [CLI] |
| non_interactive (exec) | 5 | 2 s | ×2.5 with jitter | [CLI] |
| no_retry | 1 | — | — | [CLI] |

What is retried [CLI]:
- `408`, `429`, `500` (when the body mentions internal error, overloaded or unavailable), `502`, `503`, `529`, network errors and overload errors.
- Any other `4xx` is not retried. A server header `x-should-retry: false` stops retries.
- When there is no provider rotation, overload errors get up to 10 attempts.

How long to wait [CLI]:
- For 429: honour `retry-after-ms` / `retry-after`, with a floor of 5 s and a cap of 30 s, plus up to 20% jitter.
- For overload: 0.5–1 s when another provider can be tried, otherwise 5–30 s.

Empty or "thinking only" responses [CLI]:
- They are retried once (3 times for headless proxy turns).
- If the stop reason was `length`, the next try uses 3× the output budget.

Bedrock clients run with SDK `maxAttempts: 1`, so the harness does all retrying itself. [CLI]

#### 4.6.10 Google and Bedrock (brief)

| Adapter | Notes | Source |
| --- | --- | --- |
| Google (Gemini) | Built-in Gemini models go through the proxy's chat-completions path or its `generate` path. Thought signatures (`thoughtSignature`) must be kept and sent back with the tool calls that produced them. Custom tools are unsupported | [CLI] |
| Bedrock Converse | AWS SDK `ConverseStream`. Auth is a bearer token or SigV4 (profile, region, or a credential-export command). Stop reasons map as: `end_turn`/`stop_sequence` → stop, `tool_use` → tool-calls, `max_tokens` → length, guardrail/content filter → content-filter | [CLI] |
| Bedrock OpenAI | Responses API with a Bedrock model id such as `openai.gpt-5.4`. Effort `none` is sent as `{effort:"none"}` | [CLI] |
| Bedrock Anthropic / Vertex | Anthropic Messages wire format | [CLI] |

For v1, build Anthropic, OpenAI Responses and Chat Completions first. Add Google native and Bedrock only if §4.1 lists them as supported providers. [DESIGN]

---

## 5. Tools

### 5.1 Surface [POST: "used to send 11 up front, now sends 2"]

What the CLI shows: in `script_only` mode, a fixed list of tools always stays top-level (directly
callable); everything else is reachable only as `tools.<name>(…)` inside a Script. [CLI] That list is
`Script`, `WaitForScript`, plus tools that only exist in certain contexts: ask-the-user, spec and
mission proposal tools, multi-agent controls (spawn, list, message, interrupt), a model-upgrade tool,
structured output, background-task output/stop, and the subagent `Task` tool when subagents are not
allowed inside Scripts. [CLI]

Confirmed by capture [RUN]: with Script mode on, the request carries exactly 2 tools, **`Script`**
(about 20,000 characters of description, one `script` input) and **`WaitForScript`** (`toolCallId`,
`action`). The system prompt gains a short third block (about 270 characters) saying tools are reached
through Script. Tool search itself is called from inside a Script (`tools.ToolSearch(…)`), not sent up
front. [CLI]

Direct mode (the air-gapped default for a custom model), tools actually sent [RUN]:

| Run | Tools | Tools JSON |
| --- | --- | --- |
| `exec`, default (read-only) | 6: `Read`, `LS`, `Execute`, `Grep`, `Glob`, `Skill` | 19,948 chars |
| `exec --auto low` / `medium` | 11: the 6 + `Edit`, `Create`, `TaskOutput`, `TaskStop`, `ToolSearch` | 24,803 chars |
| `exec --auto high` | 12: the 11 + `Task` (subagent) | 28,132 chars |
| `exec --skip-permissions-unsafe` | the same 12, but `Execute` drops its `riskLevel` input (schema ~900 chars instead of ~8,400) | 20,680 chars |
| Interactive app, default or `--auto high` | 15: the 12 + `ExitSpecMode`, `AskUser`, `TodoWrite` | 34,406 chars |

So `Execute` asks the model to declare a `riskLevel` only while a permission check can use it. Low and
medium autonomy send the same list; autonomy changes approvals, not tools, except that `Task` appears at
high. The interactive app's tool list did not change with `--auto high`. The interactive app always
has the todo, ask-user and spec-mode tools. `exec --list-tools` printed the same 20 registry IDs at
every level, so it shows the registry, not what a request carries.

In exec, autonomy above read-only also adds one context block (~785 chars) to the first user message.
The interactive app sends a third system block (~680 chars, 1-hour cache) about planning and todos.

Before that list applies, each tool also passes a gate: air-gapped mode, web search turned off, session
tags, feature flags, and the tool's own enabled check. [CLI]

Live flags that bear on the harness [LIVE]. Each flag defaults to off in the code; the values below are
the live ones:

| Flag | Live | Effect ("code" = traced to where it is used; "name" = read from the flag's name only) |
| --- | --- | --- |
| `adaptive_compaction_prompt` | on | Code: the summarizer picks its adaptive prompt variant. The offline captures ran with flags off, so the 2,300-char summarizer prompt measured in §4.4 is the non-adaptive one |
| `mid_conversation_tool_changes` | on | Code: passed into the tool-list resolver that handles deferred tools (§6.2). Exact behavior not traced |
| `execute_background_completion_wake` | on | Name: background `Execute` jobs wake the agent when they finish (§4.3) |
| `one_hour_anthropic_caching` | off | Code: gates the user setting for 1-hour Anthropic caching. The offline custom-model run still sent 1-hour breakpoints (§6.4); what hosted models get was not checked |
| `nested_task_delegation` | off | Name: subagents cannot start subagents. Remote limits if it is on: depth 1, 8 active per root, 15 per daemon |
| `roll_search_into_execute` | off | Name: search stays a separate tool |
| `execute_risk_classifier_shadow` | off (config) | Code (schema): an optional second risk classifier (`off` or an outside-model classifier, with a sample rate) |
| `llm_proxy_extended_stream_deadline` | on | Code: defined but never read in the CLI, so it acts in the vendor's server-side model proxy. The deadline value is not visible |

Remote config also maps each hosted model to an ordered list of upstream providers for failover
(for example, a cloud reseller first and the model's own vendor later). [LIVE] Org policy for this
account allows custom models and blocks two "ultrafast" models unless opted in. [LIVE]

Design:

- **Up front (always in the tools block):** `Script`, `script_job`. Add context tools (ask_user,
  structured output) only when the session needs them. In `direct_only` mode, also send the core direct
  tools and `load_tools`.
- **Core tools callable inside Script (and directly in `direct_only`):** `read`, `edit` / `apply_patch`,
  `create`, `execute` (shell), `grep`, `glob`, `ls`, `task` (subagent), `web_fetch`, `load_tools`.
- **Deferred:** MCP tools, connector tools, rarely used built-ins. Loaded on demand (§6.2).
- **Script control tool:** `script_job` with `wait | status | stop`. [POST; CLI has the same three actions]
- **Escape hatch:** a tool the model calls to switch itself to a stronger model when stuck. [CLI] Optional.

### 5.2 Script tool: programmatic tool calling [POST]

Input: a JavaScript program. Runs in a sandbox with **no file, network, or system access of its own**;
all side effects go through tool functions.

```js
// what the model writes
const hits = await tools.grep({ pattern: "featureFlag", path: "src" });
const files = await Promise.all(hits.files.map(f => tools.read({ path: f })));
const stale = files.filter(f => f.text.includes("LEGACY_"));
print(`${stale.length} files`, stale.map(f => f.path));
```

Requirements:

| # | Requirement | Source |
| --- | --- | --- |
| S1 | Tool functions return **real structured data** (whole files, typed search results), not prose | POST |
| S2 | Independent calls run concurrently (`Promise.all`); batch time = slowest call | POST |
| S3 | Literal text (file bodies, patches, commands) travels in **raw input blocks**, not escaped JSON strings | POST; format CLI (below) |
| S4 | Printed output is capped; full tool results are written to a per-session **result log** the model can search later | POST; caps CLI (below) |
| S5 | An `edit` inside a Script returns the same short summary as a direct edit (no file pasted back) | POST |
| S6 | Foreground Script waits up to **5 min** (300,000 ms), then returns output so far and keeps running in background | POST + CLI |
| S7 | A control line at the top of the program starts it in the background and returns immediately; harness wakes the model on completion | POST + CLI |
| S8 | Every inner tool call goes through the PermissionGate (`ToolConfirmationType.Script` exists; the CLI files Script under the "process" permission category) | SDK + CLI |
| S9 | `allowSubagentsInScripts` setting controls whether `task` is callable inside Script | SDK + CLI |
| S10 | Inner calls emit `tool_call` / `tool_result` notifications tagged with the parent Script id | DESIGN |
| S11 | Hard limits (CLI defaults below); Factory's CI sweep ran 60 at a time | POST + CLI |
| S12 | Each call gets a fresh, isolated evaluation: no state carries between Scripts, top-level `await` allowed | CLI |
| S13 | Guidance to the model: use `Promise.allSettled` for independent calls so one failure does not lose the others | CLI |

**Limits observed in the CLI [CLI]:**

| Limit | Value |
| --- | --- |
| Foreground wait before going to background | 5 min |
| Nested tool calls in flight at once | 128 |
| Total size of raw input blocks per Script | 1 MiB |
| One nested tool result | 5 MiB; larger rejects |
| Output events per Script | 1,024 |
| Total output per Script | 5 MiB |
| Text printed back to the model | 64 KiB, shared across the whole Script |
| Echo of one tool's result into output | 32 KiB |
| Over-cap text | Keeps the head and tail, with a notice pointing to the log |
| Result log | Keeps every nested result except plain file reads (those can be re-read) |

**Raw input blocks (S3).** The CLI's format [CLI], described: the Script tool's only input is a single
`script` string. Above the code, the model may write heredoc-style blocks, each opened by a comment line
that names the input and an end marker, then the literal text, then the end marker on its own line. The
code reads them as `inputs.<name>`. No JSON escaping happens inside a block.

Design [DESIGN]: use the same idea with your own syntax, for example:

```text
//# blob patch <<END
...literal text, no escaping...
END
//# run {"background": true}
const r = await tools.apply_patch({ patch: blobs.patch });
print(r.summary);
```

One string input works on every provider. For OpenAI you can also use the Responses custom/freeform
tool type so the program is not JSON-escaped at all.

**Script outputs.** The CLI allows output only through three functions: text, image, and a
notification. [CLI] Design: `print()`, `image()`, `notify()`. [DESIGN]

**Sandbox.** The CLI runs Scripts in a **separate native process**: a Rust program embedding Google's
V8 engine (rusty_v8 crate, `v8-150.4.0`), shipped inside the CLI and checked by SHA-256 before use. [CLI]
The program has no imports, `require`, Node globals, file system, or network; tools are reached only
through `tools.*`. [CLI] The Rust-to-JS protocol is serde JSON. [CLI-INF]

Design [DESIGN], in order of preference:

1. **Out-of-process V8 isolate** (match Factory): a small Rust binary using the `v8` crate, talking
   JSON over stdin/stdout. Strongest isolation; a crash cannot take down the daemon. Most work.
2. **`isolated-vm`** in the daemon. Separate V8 isolate, memory limit, quick to build.
3. **QuickJS in WASM** (`quickjs-emscripten`). Smallest, slowest.

Do **not** use `node:vm` alone; it is not a security boundary. Expose only `tools.*`, `inputs`/`blobs`,
`print`, `image`, `notify`, JSON, and a small utility set. No `require`, `fetch`, `process`, timers.

**Result shape returned to the model:**

```json
{ "status": "completed|running|failed|timed_out",
  "job_id": "scr_…",
  "output": "<capped printed text>",
  "tool_calls": 312, "errors": [{"call": 17, "tool": "edit", "message": "…"}],
  "log_ref": "results/scr_….jsonl" }
```

### 5.3 Direct mode

Same tools exposed directly when `toolExecutionMode = direct_only`. Per-model profiles pick the default.
Factory's goal during tuning: when both are offered, the model should choose Script. [POST]

### 5.4 File reads

Line numbers on every read cut cost for some models and raised it for others (+8% GLM, +32% Kimi). [POST]
Make line numbers an option the model asks for (`read({path, lineNumbers: true})`), default off;
profiles may override.

### 5.5 Permissions, risk and autonomy

#### 5.5.1 Vocabulary

| Thing | Values | Source |
| --- | --- | --- |
| Interaction mode | `auto`, `spec`, `mission` (`agi` is a deprecated alias) | [SDK] |
| Autonomy level | `off`, `low`, `medium`, `high`. Default for a new session is `off` | [SDK], default [CLI] |
| Legacy combined mode | `normal` (= auto + off), `spec`, `auto-low`, `auto-medium`, `auto-high` | [SDK] |
| Command risk (model-declared) | `low`, `medium`, `high` | [CLI] |
| Confirmation types | `edit`, `create`, `apply_patch`, `exec`, `mcp_tool`, `ask_user`, `exit_spec_mode`, `sandbox_violation`, `droid_shield_violation` (secret scan), `script`, plus mission types | [SDK] |
| Confirmation outcomes | `proceed_once`, `proceed_always`, `proceed_always_file`, `proceed_edit`, `cancel`; spec exits `proceed_auto_run[_low/_medium/_high]`, `proceed_new_session[_low/_medium/_high]`; MCP `proceed_always_tools`, `proceed_always_server`; secret scan `proceed_report_false_positive` | [SDK] |
| Sandbox violation | type `filesystem-read` / `filesystem-write` / `network` / `tool`; reason `deny-list` / `not-allowed` | [SDK] |
| Sandbox mode | `per-command` (default), `whole-process` | [SDK], default [CLI] |

What the levels mean to the user [CLI]:
- Off: every action needs approval.
- Low: file edits and read-only commands run on their own.
- Medium: reversible commands run on their own too.
- High: all commands run on their own.

#### 5.5.2 Model-declared risk on Execute

- The Execute input carries `riskLevel` (`low|medium|high`) and a one-line `riskLevelReason`. [CLI]
  - This harness names the reason field `riskReason` and makes it required (prompts.md §5.3). Keep that name. [DESIGN]
- When permissions are active and `riskLevel` is missing, the call is **not run**. [CLI]
  - The tool result tells the model to send the call again with the field filled in.
  - The confirmation UI string for this case is "Missing risk classification".
- When permissions are skipped (`--skip-permissions-unsafe`), the field is removed from the schema the model sees (already in §5.1). [CLI]
- Any value other than low/medium/high is treated as `high`. [CLI]
- If a PreToolUse hook rewrites the command, the model's risk fields are dropped and the rewritten command is judged as unrated (so it asks). [CLI]
  - The hook config can set `preserveRiskLevel: true` to keep them. [CLI]
- The harness may raise the model's rating, never lower it (prompts.md §5.3). [DESIGN]
  - The CLI has an optional shadow risk classifier (a second opinion). It is off by default. [CLI]
  - For v1, raise ratings only through the policy lists below. No second model. [DESIGN]

#### 5.5.3 Decision order for one Execute call

The harness classifies each command in this order. The first match wins. [CLI]

1. **Skip-all.** If `--skip-permissions-unsafe` is set, the command runs. Nothing is asked.
2. **Policy lists.** The command is split into segments on `;`, `&&`, `||`, `|` and newlines. Then:
   - **block:** any segment matches the blocklist or a block rule. The call is refused before it runs and the model gets a "blocked command" error.
   - **ask:** any segment matches the denylist, a built-in safeguard, or an ask rule. The user is **always** asked, at every autonomy level. The prompt shows high impact and names the matched entry, for example "Built-in safety: `<id>`" or "Rule: `<id>`".
   - **allow:** *every* segment matches the allowlist or an allow rule. The command runs with no prompt, even at Off.
     - Segments that are only `head`, `tail`, `grep`, `cat` or `echo` are ignored for this check, so `git log | head` still counts as allowed.
     - If any segment can't be parsed, the whole command is not auto-allowed.
   - **no match:** go on to step 3.
3. **Risk vs autonomy.** Rank the risk: unrated = 0, low = 1, medium = 2, high = 3. Rank the autonomy: off = 0, low = 1, medium = 2, high = 3.
   - If risk rank ≤ autonomy rank, the command runs. Otherwise the user is asked.
   - Unrated never reaches this step (see 5.5.2).
   - In mission mode, effective autonomy is always `high`.

Precedence: **block > ask > allow > risk**. [CLI]

**Default lists.** Settings keys: `commandAllowlist`, `commandDenylist`, `commandBlocklist`. [CLI]

| List | Default entries |
| --- | --- |
| Allow | `ls`, `pwd`, `dir`, `git status`, `git diff`, `git log`, `git show`, `git blame`, `git ls-files` |
| Deny (always ask) | `rm -rf` / `rm -r` aimed at `/`, `/*`, `.`, `~`, `~/*`, `$HOME`; `mkfs` and `mkfs.ext4/.ext3/.vfat/.ntfs`; `dd if=/dev/zero of=/dev`, `dd of=/dev`; `shutdown`, `reboot`, `halt`, `poweroff`, `init 0`, `init 6`; two fork-bomb spellings; `chmod -R 777 /`, `chmod -R 000 /`, `chown -R`; `Format-Volume`, `format.com`, `powershell Remove-Item -Recurse -Force` |
| Block | empty |

Exception: an `rm` whose targets are all under `/tmp` is not treated as deny-listed. [CLI]

How the lists match [CLI]:
- A list entry is split into tokens. It matches a segment case-insensitively, on token boundaries, and allows up to 100 characters between tokens.
- Package-runner wrappers are unwrapped first: `npx`, `bunx`, `pnpm dlx`, `npm exec`.
- `powershell -Command "<body>"` is parsed into its body. `-EncodedCommand` counts as unparseable.

**Built-in allow rules** (newer rules engine, behind flag `CliRulesEngine`) [CLI]:

| Rule id | What it allows |
| --- | --- |
| `builtin/directory-list-allow` | Commands starting `ls` or `dir`. `ls -la` matches; `lsof` does not. Matching is case-sensitive |
| `builtin/pwd-allow` | Commands starting `pwd` |
| `builtin/git-inspection-allow` | `git` + one of `status`, `diff`, `log`, `show`, `blame`, `ls-files` |

The git rule does not match `git -C /repo status` or `/usr/bin/git status`.

Built-in safeguard ids (the deny groups) [CLI]: `rm-protected-target`, `filesystem-format`, `system-power`, `init-runlevel`, `dd-zero-device-write`, `dd-device-write`, `chmod-recursive-mode`, `chown-recursive`, `windows-format`, `powershell-force-delete`.

Rules can come from these scopes [CLI]: org, runtime, user, project, folder, dynamic, builtin. Org rules cannot be loosened by lower scopes. [CLI-INF]

For v1, ship the three lists plus the safeguard ids as data. A rule has `{id, decision: allow|ask|block, match: {prefix: string[] | string[][]}, reason}`, and the merge order is org > project > user > builtin. [DESIGN]

#### 5.5.4 Other tools

| Tool | Off | Low | Medium | High | Source |
| --- | --- | --- | --- | --- | --- |
| Read, LS | auto | auto | auto | auto | [CLI] |
| Grep, Glob | auto | auto | auto | auto | not checked; [DESIGN] |
| Create, Edit, ApplyPatch | **ask** | auto | auto | auto | [CLI] |
| Execute | see 5.5.3 | | | | [CLI] |
| MCP tool | ask unless remembered (5.5.5) | | | | [CLI] |
| WebSearch, FetchUrl | they have their own confirmation strings, so they can ask. The gating rule was not found. | | | | [CLI] / not found |

- File edits auto-approve when the mode is auto or mission **and** autonomy is not `off`. [CLI]
- The edit prompt shows a diff of old and new content. The create prompt shows the new file's content. [CLI]
- For WebSearch and FetchUrl, ask at Off and auto at Low and above. [DESIGN]

#### 5.5.5 "Always allow" memory

| Prompt | Option | What it remembers | Source |
| --- | --- | --- | --- |
| Command or edit | "Yes, and always allow `<level>`" (`proceed_always`) | **Raises the session's autonomy** to the lowest level that would have auto-approved this call (`auto-low`/`-medium`/`-high`). It is not a per-command memory | [CLI] |
| MCP tool | "Always allow `<tool>`" (`proceed_always_tools`) | That tool, saved in settings with its impact level | [CLI] |
| MCP server | "Always allow all `<server>` tools" (`proceed_always_server`) | Every tool on that server | [CLI] |
| Sandbox violation | "Allow always (writes to `<parent dir>`)" = `proceed_always`; "(writes to `<exact path>`)" = `proceed_always_file`. The same pair exists for reads; network is per domain; there is also "Remove X from deny list" | Added to user sandbox settings | [CLI] |

- The "always" option is **hidden** when any command in the batch is deny-listed. [CLI]
- It is also hidden when the needed level is above the org's maximum autonomy. [CLI]
- A per-command session approval list exists in the code (`addAllowedCommand`), but nothing calls it. [CLI]
- v1 should copy the CLI here: "always" raises the session autonomy level and does not save command strings. [DESIGN]
- A batch of several tool calls gets one prompt with "Yes, allow all" and "No, cancel all". [CLI]
- A Script call is expanded into one confirmation per inner call that needs one. [CLI]

#### 5.5.6 Headless (`exec`) mode

- `--auto low|medium|high` sets the autonomy level. With no flag the level is Off. [CLI]
- `--auto` and `--skip-permissions-unsafe` cannot be used together. [CLI]
- Headless mode never prompts. A call that would need a prompt fails the run with an error telling the user to re-run with a higher `--auto` or with skip-permissions. [CLI]
  - The setting `autoRejectPermissionRequests` turns that into "reject the call and let the model continue". [CLI]
- Subagents always auto-reject when they are in headless or ACP sessions. [CLI]
- The Task (subagent) tool is offered only at `high` or with skip-permissions, and only at depth 0. [CLI]

#### 5.5.7 Spec mode (read-only planning)

- **Blocked:** Create, Edit and ApplyPatch, unless every target path is inside `.factory/specs/`. The blocked call is cancelled, and the tool result tells the model spec mode is active. [CLI]
  - Rigwell uses its own folder, `.rigwell/specs/`. [DESIGN]
- **Execute keeps the normal 5.5.3 rules.** It is not forced to read-only in code; the spec-mode prompt tells the model to use read-only tools. [CLI-INF]
  - For v1, also refuse Execute calls with risk above `low` while in spec mode. That enforces the read-only promise in code. [DESIGN]
- **Subagents:** a subagent told that its parent is in spec mode must not start its own subagents. [CLI]
- **Model:** spec mode can use its own model and effort (`specModeModel`, `specModeReasoningEffort`). [CLI]
  - When switching auto → spec with no spec model set, the current effort is carried over. [CLI]
  - Flags: `--use-spec`, `--spec-model`, `--spec-reasoning-effort`. [CLI]
- **Tools:** the tool list gains `ExitSpecMode` only while spec mode is on. [CLI]

**ExitSpecMode** [CLI]:
- Display name: "Propose Specification".
- Input: `{ title?: string, plan: string /* markdown */ }`.
- Output: `{ approved: boolean }`.
- An empty `plan` returns an error.
- It always asks for confirmation (type `exit_spec_mode`). The payload carries the plan, the title, `contextSavingsPercent` and `supportsClientStartedHandoff`.

| User choice | Outcome sent | Effect |
| --- | --- | --- |
| Proceed (manual approvals) | `proceed_once` | Mode becomes auto, autonomy `off` |
| Proceed with Low / Medium / High | `proceed_auto_run_low/medium/high` | Auto mode at that level. Each option is shown only if the org maximum allows it |
| Proceed with a comment | `proceed_once` + comment | The comment is passed on as guidance |
| Edit the spec first | `proceed_edit` + `editedSpecContent` | The edited plan replaces the model's plan |
| Hand off to a new session (shows % context saved) | `proceed_new_session[_low/_medium/_high]` | A new session starts with the spec as its brief |
| No, keep iterating / explain why | `cancel` (+ optional reason) | Stays in spec mode |

- After approval, the model is told that spec mode has ended and all tools are back. [CLI]
- The approved spec is saved to a folder. The setting is `specSaveDir`; choices offered are the project's `.factory/docs` or `~/.factory/docs`. [CLI]
- ExitSpecMode is not offered in headless mode. [CLI]
- For v1, support only: proceed (manual), proceed at Low/Medium/High, edit, and keep iterating. Leave out new-session handoff. [DESIGN]

#### 5.5.8 Sandbox

| Item | Behaviour | Source |
| --- | --- | --- |
| Settings | `sandbox: { enabled, mode, filesystem{allowWrite, allowRead, denyWrite, denyRead}, network{allowedDomains, deniedDomains (no "*"), allowUnixSockets, allowAllUnixSockets, allowLocalBinding, httpProxyPort, socksProxyPort} }` | [CLI] |
| Engine | Linux: bubblewrap + socat + seccomp filter. macOS: `sandbox-exec`. **Windows: unsupported** (it errors) | [CLI] |
| `per-command` | Each Execute command is wrapped in the sandbox; the agent itself runs outside it | [CLI] |
| `whole-process` | The whole agent is relaunched inside the sandbox, using a policy hash and a control channel; a PTY is allowed. This needs the agent to run as a separate process | [CLI] |
| Always writable | The working folder plus the agent's own state folders | [CLI] |
| Always denied | Reading the credential files; writing them, the org-managed settings, the certs folder, or the agent's bin/tools folders | [CLI] |
| Network | Allowed: the vendor API host(s) plus `allowedDomains` | [CLI] |
| Violations | Up to 500 are kept per session. Each one prompts as described in 5.5.5 | [CLI] |
| Org merge | The stricter setting wins: `whole-process` beats `per-command`; allow lists are intersected | [CLI] |

For v1, ship `per-command` on Linux and macOS only. On Windows, report that the sandbox is unavailable and rely on 5.5.3. [DESIGN]

### 5.6 Hooks

#### Config

- Where hooks are read [CLI]:
  - `hooks.json` at a settings folder root (legacy: `hooks/hooks.json`);
  - the `hooks` key in that folder's `settings.json`;
  - plugins: `<plugin>/hooks/hooks.json`.
- Inside one folder, `hooks.json` replaces `settings.json` per event key. [CLI]
- Across levels (org, user, project, folder, …) the lists for each event are **concatenated**, so every level's hooks run. [CLI]
- `hooksDisabled` and `showHookOutput` take the first level that sets them. [CLI]
- An org setting `allowManagedHooksOnly` drops all non-org hooks. [CLI]
- Hook files are read with a 1 MiB cap. [CLI]

Schema [CLI]:

```json
{
  "hooksDisabled": false,
  "showHookOutput": true,
  "PreToolUse": [
    {
      "matcher": "Edit|Create",
      "commandRegex": "^git push",
      "hooks": [
        { "type": "command", "command": "python check.py", "timeout": 60, "preserveRiskLevel": false }
      ]
    }
  ]
}
```

- `matcher` [CLI]:
  - Empty, missing or `*` matches all.
  - Otherwise an exact match is tried first, then a regex.
  - A bad regex never matches.
  - Events with no match value (shown as "—" below) run every hook regardless of `matcher`.
- `commandRegex` only applies to the `Execute` tool. A config that has it is skipped for other tools. [CLI]
- `preserveRiskLevel`: when a hook rewrites tool input, the risk level is normally recomputed; true keeps the original. [CLI]

#### Running

| Topic | Behavior | Tag |
|---|---|---|
| Order | All matching commands for an event run **in parallel**. Results are checked in config order (first match of each kind wins). | [CLI] |
| Timeout | `timeout` seconds, default 60. On timeout: SIGTERM, counted as exit 1. | [CLI] |
| Cancel | User cancel counts as exit 1 | [CLI] |
| Shell | Windows: `%ComSpec% /d /s /c <cmd>` (fallback `C:\Windows\System32\cmd.exe`). Others: `sh -c`. cwd = project dir. | [CLI] |
| Env | Process env plus `FACTORY_PROJECT_DIR` (also `DROID_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`). Plugin hooks also get the plugin root. | [CLI] |
| stdin | The event's JSON object (below) | [CLI] |
| stdout | Parsed as JSON only if it starts with `{`. Otherwise it is plain text. | [CLI] |
| Skips | Not run when `hooksDisabled` is set or the folder is not yet trusted | [CLI] |
| Logging | Each run is saved in the session and sent as `hook_execution_started` / `hook_execution_completed` notifications | [CLI] / [SDK] |
| Our build | Same, minus plugin env and sandbox wrapping | [DESIGN] |

stdout JSON fields (all optional) [SDK] / [CLI]:

| Field | Meaning |
|---|---|
| `continue` | false = stop (meaning per event below) |
| `stopReason` | text shown when `continue` is false |
| `suppressOutput` | hide this hook's output in the UI |
| `systemMessage` | note shown to the user |
| `decision` / `reason` | `block` (or `approve`) plus why |
| `hookSpecificOutput.permissionDecision` | `allow`, `deny` or `ask` (PreToolUse) |
| `hookSpecificOutput.permissionDecisionReason` | why |
| `hookSpecificOutput.additionalContext` | text added to the model's context |
| `hookSpecificOutput.updatedInput` | partial input merged over the original |

- Context text = `additionalContext`, or plain non-JSON stdout, trimmed. It is used only when exit code is 0. [CLI]

Exit codes, general meaning [CLI]:

| Exit | Meaning |
|---|---|
| 0 | OK; stdout may carry JSON or context |
| 1 | Non-blocking warning (stderr may be shown or logged) |
| 2 | Block this step; stderr is the reason fed back |
| 3 | Abort the whole agent turn; stderr is the message |

#### Stdin by event

Every event gets `session_id`, `transcript_path`, `cwd`, `permission_mode` (`off`, `spec`, `auto-low`, `auto-medium`, `auto-high`) and `hook_event_name`. [CLI] Extra fields:

| Event | Matcher value | Extra stdin fields | Tag |
|---|---|---|---|
| SessionStart | `source` | `source` (startup, resume, compact seen), `previous_session_id`, `calling_session_id`, `message_id` (not on startup), `CLAUDE_ENV_FILE` | [CLI] |
| SessionEnd | — | `reason` (clear, logout, prompt_input_exit, other seen), `session_duration_ms`, `message_count`, `message_id` | [CLI] |
| UserPromptSubmit | — | `message_id`, `prompt`, `has_images` | [CLI] |
| PreToolUse | tool name | `tool_name`, `tool_input` | [CLI] |
| PostToolUse | tool name | `tool_name`, `tool_input`, `tool_response` | [CLI] |
| Stop | — | `message_id`, `stop_hook_active`, `tool_execution_count`, `elapsed_time` (ms) | [CLI] |
| SubagentStop | — | `task_name`, `task_result` (string), `task_error`, `stop_hook_active` (always false) | [CLI] |
| PreCompact | — | `trigger` (manual or auto), `custom_instructions`, `message_count`, `estimated_tokens`, `message_id` | [CLI] |
| Notification | — | `message_id`, `message`, `notification_type` (permission_prompt, idle_prompt, elicitation_dialog) | [CLI] |

#### Outcomes by event

| Event | What the harness does with results | Tag |
|---|---|---|
| SessionStart | Runs in the agent process, children included. Waits up to 60 s; slower hooks finish in the background and are applied late. Lines `export K=V` written to the `CLAUDE_ENV_FILE` path are set as env vars, then the file is deleted. Context text from all hooks is joined and added before the first turn. Exit codes do not block. | [CLI] |
| SessionEnd | Runs once per session, only if the session file exists. Non-zero exits are only logged. Process exit waits for it. | [CLI] |
| UserPromptSubmit | Blocked if any hook exits 2 or 3, sets `continue:false`, or sets `decision:block`. The error shown is the reason, stderr, stopReason or systemMessage. `updatedInput.prompt` replaces the prompt. Context text from all hooks is joined and sent with the prompt. | [CLI] |
| PreToolUse | `continue:false` stops the turn. Exit 3 aborts the agent. `permissionDecision`: `allow` skips confirmation (and applies `updatedInput`), `deny` refuses the call with the reason, `ask` falls through to normal confirmation. Exit 2 refuses the call with stderr. `updatedInput` alone is merged in, then risk and policy checks rerun on the new input. Exit 1 with stderr is logged as a warning. | [CLI] |
| PostToolUse | Skipped if the tool was cancelled. `continue:false` stops the turn. `additionalContext` goes to the model. `systemMessage` goes to the user. Exit 3 aborts. Exit 2 sends stderr to the model as feedback (the tool result stands). Exit 1 with stderr is shown as a warning. | [CLI] |
| Stop | `continue:false` ends the turn with stopReason shown. `systemMessage` is shown to the user. Exit 3 aborts. `decision:block` with `reason`, or exit 2 with stderr, makes the agent keep going with that text, and `stop_hook_active` is true on the next Stop. If the user stopped the agent, a Notification (idle_prompt) fires instead of Stop. | [CLI] |
| SubagentStop | Fire-and-forget after a child ends. Results are ignored. | [CLI] |
| PreCompact | Exit 2 or 3 cancels a **manual** compaction. Automatic compaction cannot be blocked. | [CLI] |
| Notification | Fire-and-forget. Results are ignored. | [CLI] |

- The only loop guard found on Stop is the `stop_hook_active` flag. Hook authors must check that flag themselves. [CLI]
- Optional, for Scott to decide: add a hard cap on Stop-hook continuations per turn. [DESIGN]

#### Hooks and Scripts

- Tool calls made **inside a Script** pass the PreToolUse check. A deny, exit 2 or stop becomes a script-side error saying the inner call was rejected by policy. [CLI]
- No PostToolUse call site was found for inner Script calls. PostToolUse runs only in the main tool loop, so the outer `Script` call itself gets it. [CLI-INF]
- **Our build:**
  - Fire PreToolUse for inner calls, as the CLI does. [DESIGN]
  - PostToolUse fires once, for the outer `Script` call, as the CLI does. [DESIGN]
  - Optional: also fire PostToolUse for inner calls. That is an open decision (§10). [DESIGN]

### 5.7 MCP

Stdio, HTTP, SSE servers. [SDK] Start servers in parallel with the first turn; never block turn 1 on
a slow server. [POST] Discovered MCP tools are deferred and loaded per §6.2.

### 5.8 Skills

Sources: the static CLI bundle and the SDK type file; nothing was run. Where the CLI and `prompts.md` differ, the difference is called out, and the build keeps the `prompts.md` shape unless noted.

#### Where skills live

| Location | Path | Bucket | Tag |
|---|---|---|---|
| Project | `<repo>/.factory/skills/<name>/SKILL.md` | project-dir | [CLI] |
| Project (alt dirs) | `<repo>/.agents/skills/<name>/SKILL.md`, `<repo>/.agent/skills/<name>/SKILL.md` | project-dir | [CLI] |
| Personal | `~/.factory/skills/<name>/SKILL.md` (also `~/.agents`, `~/.agent`) | user-dir | [CLI] |
| Nested folder | `<subdir>/{.factory,.agents,.agent}/skills/*/SKILL.md`, found on demand (see Discovery) | folder-dir / dynamic | [CLI] |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | org-plugin / project-plugin / user-plugin | [CLI] |
| Mission | `<missionDir>/skills/` | mission | [CLI] |
| Built-in | bundled with the binary | builtin | [CLI] |

- A `skill.mdx` file name is also accepted by the bundled skill docs. [CLI-INF]
- Folder watchers pick up changes with a 300 ms debounce. [CLI]
- **Our build:** support `.factory` and `.agents` under project and home, plus built-ins. Plugins, missions and automation buckets are out of scope unless the spec adds them. [DESIGN]

#### File format

A skill file is a Markdown file. It may start with a YAML frontmatter block between `---` lines; the rest is the body. [CLI]

| Field | Type | Required | Default | Meaning | Tag |
|---|---|---|---|---|---|
| `name` | string | yes | — | Must match `^[a-z0-9-]+$` | [CLI] |
| `description` | string | yes | — | One-line summary shown to the model | [CLI] |
| `allowed-tools` | string or string[] | no | — | Tools the skill expects. Wins over `tools` | [CLI] |
| `tools` | string or string[] | no | — | Older name for the same thing | [CLI] |
| `version` | string | no | — | Semver; a bad value is dropped, not an error | [CLI] |
| `license`, `compatibility` | string | no | — | Informational only | [CLI] |
| `metadata` | map | no | — | Free-form | [CLI] |
| `enabled` | bool | no | true | false hides the skill | [CLI] |
| `user-invocable` | bool | no | true | Can the user call it by name | [CLI] |
| `disable-model-invocation` | bool | no | false | true keeps it out of the model's list | [CLI] |

Parsing rules [CLI]:
- If the frontmatter is not valid YAML, a simple `key: value` parser is tried. If that also fails, there is no metadata and the whole file is the body.
- If the frontmatter fails schema checks, the skill is still loaded but marked **disabled**, with an empty description.
- Parse results are cached by file mtime and content (LRU, 256 entries).

Validation [CLI]:

| Kind | Rule |
|---|---|
| Error (skill is invalid) | name missing; name not `^[a-z0-9-]+$`; body empty |
| Warning (still loads) | description over 200 chars; unknown tool entry; version not semver; body under 50 or over 10,000 chars |

#### Precedence and conflicts

- Bucket order, first wins: org-plugin, runtime, mission, automation, folder-dir, project-dir, project-plugin, user-dir, user-plugin, dynamic, builtin. [CLI]
- Names are compared after normalizing (lowercase; any char outside `a-z0-9-` becomes `-`). [CLI]
- Same name in the same bucket: the first one found wins; the other is a collision. [CLI]
- Same name in a later bucket: marked **shadowed**. [CLI]
- Each skill ends up with one status: enabled, disabled, invalid, shadowed. Only valid and enabled skills are offered. [CLI]
- Users can turn skills off with a `disabledSkills` list in settings (any level). [CLI]
- When built-ins are turned off for a session, built-in skills are dropped. [CLI]
- **Our build:** keep the rule "project beats personal beats built-in; first found wins inside a level". [DESIGN]

#### Listing skills to the model

- The CLI lists skills in a system-reminder block, one line per skill: `name: description`. [CLI]
  - Our build puts the same list in the `ctx_skills` block from prompts.md §4.3. [DESIGN]
- Descriptions: whitespace collapsed, cut to 200 chars with an ellipsis. [CLI]
- Budget: about 1.5% of the model's context window, in characters (`tokens × 4 × 0.015`). If the window is unknown, 8,000 chars. [CLI]
  - Built-in skills always get a full line.
  - Others get a full line in priority order while budget lasts, then name only.
- Skills with `disable-model-invocation: true` are left out. [CLI]
- If no skill is model-invocable, the Skill tool is removed from the tool list. [CLI]

#### Discovery during a session

- When a tool touches a path, the CLI walks the folders from the git root (or cwd) down to that path. It looks for `{.factory,.agents,.agent}/skills/*/SKILL.md` in each. [CLI]
  - At most 24 folders per call. [CLI]
  - New skills are announced to the model in a short "additional skills" reminder. [CLI]
  - After compaction, announced skills move into the main list. [CLI]
- **Our build:** do this walk too, since the spec allows repo subfolders to carry their own skills. [DESIGN]
  - Optional: skip it in v1 and only scan at session start. [DESIGN]

#### The Skill tool

| Item | CLI | Our build (prompts.md §5.6) | Tag |
|---|---|---|---|
| Input | `{skill: string}` | `{name, args}` | [CLI] / [DESIGN] |
| Side effects | filesystem read; no confirmation; allowed in read-only mode | same | [CLI] |
| Not found / invalid / disabled | tool error naming the problem (invalid lists the validation errors) | same | [CLI] |
| Success result | A one-line "skill now active" note, then the body wrapped in a `<skill name=… filePath=…>` tag | Script return `{name, instructions}`; direct-mode text = the same wrapped body | [CLI] / [DESIGN] |
| Size cap | the tool's result budget (shared constant) | cap body at 10,000 chars (matches the warning limit); cut with a marker | [CLI] / [DESIGN] |

- The body goes back as a **tool result**, not as a new system message. The skill stays "active" only because it sits in history. [CLI]
- `args` (our addition): append to the result as a short "arguments" line after the body. Do not template it into the body. [DESIGN]
- Supporting files: the SDK lists `resources` (`reference` or `asset`) per skill. [SDK]
  - The model reads them with Read if the body points at them. Nothing is preloaded. [CLI-INF]

### 5.9 Subagents and custom droids

#### Custom droid files

- Location: `<repo>/.factory/droids/<name>.md` (project) or `~/.factory/droids/<name>.md` (personal). Plugins can add a `droids/` folder. [CLI]
- Format: Markdown with optional frontmatter. The body is the subagent's system prompt. [CLI]

| Field | Type | Default | Meaning | Tag |
|---|---|---|---|---|
| `name` | string | file base name | id used as `subagent_type` | [CLI] |
| `description` | string | — | shown in the Task catalog | [CLI] |
| `model` | string | `inherit` | model id, or `inherit` = parent's model | [CLI] |
| `reasoningEffort` | string | parent's | effort for that model | [CLI] |
| `tools` | string or string[] | all allowed | allow-list (comma string accepted) | [CLI] |
| `mcpServers` | string or string[] | — | MCP servers the droid may use | [CLI] |

- If the named model is not valid, it falls back to `inherit`. [CLI]
- Conflicts: same rule as skills (normalized name, first found wins). Project droids are read before personal ones. [CLI]
- **Our build:** support `name`, `description`, `model`, `reasoningEffort`, `tools`. Leave out `mcpServers` unless MCP is in scope. [DESIGN]

#### Task tool (CLI vs our build)

| Item | CLI | Our build (prompts.md §5.14) | Tag |
|---|---|---|---|
| Inputs | `subagent_type`, `description` (3–5 words), `prompt`, `image_paths?`, `complexity?`, `resume?` (child session id) | `description`, `prompt`, `agent`, `background` | [CLI] / [DESIGN] |
| Background | **No model parameter.** Direct Task calls run in the background by default (except in mission-worker sessions). Scripts set it per call. | keep `background` as a model choice, default false | [CLI] / [DESIGN] |
| Result | Final report is delivered to the parent as a model-only system message when the child ends | Script return `{report}`; in direct mode the tool result is the report | [CLI] / [DESIGN] |
| Collect / stop | `TaskOutput {task_id, block=true, timeout=30000 ms, max 1,200,000}`; `TaskStop {task_id}` (SIGTERM, then SIGKILL) | same | [CLI] |
| Availability | Only at depth 0, and only at `--auto high` unless a flag allows it at any level | same as spec §5.1 | [CLI] |

#### Child session

| Topic | Behavior | Tag |
|---|---|---|
| Session and context | Each subagent is its own child session with its own id, history and context window. It starts from the prompt only, not the parent's history. | [CLI] |
| Transcript | Stored like any session (sessions dir, default `~/.factory/sessions/`), linked to the parent by parent / calling-session ids | [SDK] / [CLI-INF] |
| Model | Custom droid: its `model`, else inherit. Built-in types: per-complexity subagent model setting if set, else the session model with effort capped by `complexity`. | [CLI] |
| Tools | Droid `tools` list if given, else the normal set. `Task` is removed for children (depth > 0). | [CLI] |
| Permissions | Child autonomy = the subagent autonomy setting if set, else the parent's; never above the max allowed; read-only droids capped at low. Mission sessions use high. | [CLI] |
| Inactivity | Child is failed after 15 min with no activity (setting, minimum 1 min) | [CLI] |
| Status | pending, running, completed, failed, cancelled | [SDK] |
| Summary record | childSessionId, subagentType, description, status, toolUseCount, durationMs | [SDK] |
| Token usage | Child usage is added to the parent's totals | [CLI] |
| Resume | `resume` with the child id continues that child with its full history | [CLI] |

#### Limits

| Limit | Default | Max (clamp) | Tag |
|---|---|---|---|
| Nesting depth | 1 | 1 | [CLI] |
| Active descendants per root session | 5 | 25 | [CLI] |
| Active Task subagents per daemon (machine) | 10 | 100 | [CLI] |

- These values come from a server-tunable config (`nested_task_delegation_limits`). They only apply when the nested-delegation flag is on. [CLI]
- Live server values: 8 per root and 15 per daemon (depth 1). [LIVE] The table shows the code defaults, used when the server sends nothing.
- Over the limit, the Task call fails with a "limit reached, wait for a task to finish" error. [CLI]
- **Our build:** depth 1 (no Task in children), 5 per root, 10 per process. Hard-coded with a config override. [DESIGN]

---

## 6. Request building and prompt cache

### 6.1 Append-only rule [POST]

Providers cache by prefix; any byte change invalidates everything after it. The request is
`[system][tools][history…]` and only ever grows at the end. Volatile data (git status, time, cwd changes)
goes in **new messages at the end**, never edits to earlier blocks.

### 6.2 Loading tools without breaking cache [POST]

Never insert into the tools block mid-session.

What the CLI does [CLI]:

- Tools are split three ways: core (always sent), loaded deferred, and hidden.
- Deferred tools are announced by **name only** in a reminder message ("deferred tools" list). Later
  changes arrive as small delta reminders: tools that just became available or are no longer available.
- In `script_only` mode the model loads a tool by calling tool search inside a Script. Loaded tools are
  announced in a "script bindings loaded" reminder, deduplicated by hash so the same announcement is not
  sent twice. An MCP tool named `server__tool` becomes `tools.server.tool`.
- The top-level `tools` array is not changed for script-mode loads.
- An MCP server that connects and drops 6 or more times is suppressed.

Design [DESIGN]: the same. Announce deferred names in an appended message; when `load_tools` returns,
append a message with the loaded signatures and make them callable through Script. In `direct_only`
mode, use a generic `call_tool({name, args})` direct tool rather than editing the `tools` array.

### 6.3 Cache monitor [POST]

For every request, compare with the previous one for that session; if it is not a strict extension,
log the first divergent block and its cause. Track two numbers:

- share of input tokens read from cache (Factory production: 98% median per request, 91.5% token-weighted)
- share of requests that are strictly append-only (Factory: 98.6%)

### 6.4 Base prompt budget [POST]

Factory's first request: 20,887 → 13,055 tokens. Set a budget and a CI test that fails if the first
request grows past it.

Observed first request, custom Anthropic-format model, air-gapped [RUN]:

| Part | Direct mode (A) | Script mode (B) |
| --- | --- | --- |
| Whole request body | 31,881 chars | 33,601 chars |
| System prompt | 2 blocks: 65-char identity line + 6,065 chars | 3 blocks: 65 + 5,718 + 268 chars |
| Tools JSON | 6 tools, 19,948 chars | 2 tools, 21,479 chars |
| First user message | 5 context blocks (~5,460 chars: environment, working directory, etc.) + the prompt | same, ~5,470 chars |
| `max_tokens` / streaming | 32,000 / on | 32,000 / on |

Token counts were not measured; the fake server only estimated them. At about 4 characters per token,
the request is roughly 8,000 tokens, smaller than the post's 13,055 because there are no MCP tools,
skills or project files. Tools are the biggest share in both modes. Prompt caching uses `ephemeral`
breakpoints with a **1-hour TTL**: on the last system block, on two of the context blocks, and on the
newest user message. Other request details: Anthropic SDK (Stainless JS 0.128.0), `anthropic-version
2023-06-01`, a 600-second client timeout (matches the 10-minute `llmRequestTimeout` default, §4.2), and
no `temperature`, `thinking` or `metadata` fields for this model. Report a context breakdown by category (system prompt, tools, MCP tools,
user info, AGENTS.md, custom agents, skills, messages) [SDK `ContextCategoryColorKey`].

Interactive app [RUN]: the main request is 3 system blocks (65 + 6,195 + 676 chars), 15 tools (34,406
chars), `max_tokens` 32,000. Before it, the app sends a small side request with no tools, a 1,299-char system
block, one short user message and `max_tokens` 8,224, which is 32 + the 8,192 headroom (§4.4). Its purpose
was not checked; the small output limit suggests something like a session title. The app's
`/context` view showed this run as about 1.6k tokens of system prompt and 8.4k of tools.

Periodic automation: give a model the system prompt and ask for repeated, contradictory, or unclear
guidance; each finding becomes a tested proposal. [POST]

---

## 7. Performance targets

From Factory's reported numbers [POST]; use as targets, not requirements.

| Metric | Target |
| --- | --- |
| Turn preparation (Enter → request sent) | ≤ 125 ms; cache the connected-apps list until a connection changes |
| Pre-flight tool lookup | ~1 ms; read only the newest part of session history |
| Auth checks | Parallel, deduplicated |
| `exec` time to first model request | < 700 ms; send identity/flags/policy requests while code loads |
| First paint / first prompt accepted | < 500 ms / < 650 ms |
| First-keystroke p95 | ≤ 250 ms, enforced in CI |
| Daemon launch → ready | < 400 ms; load shell env, certs, skills just in time |
| Per extra session memory | ~20 MB |
| Quit | ~30 ms; hand telemetry/sync to a detached process |

---

## 8. Eval loop ("agent factory") — phase 3

[POST] Process, adapted:

1. **Model intake.** When a new model/snapshot appears, auto-create a profile and run behavioral
   assertions (tool-call format, follows Script contract, respects permissions). Passing is the floor.
2. **Continuous evals.** Daily benchmark runs (e.g. Terminal-Bench), plus your own task suite; ingest
   live error logs and user friction per model.
3. **Failure mining.** An agent clusters failures that repeat across tasks *and* models.
4. **Proposals.** Each proposal states a hypothesis and the change (prompt, tool description, result
   shape, guard threshold).
5. **Controlled experiment** on every model family it touches; ship only if the goal holds on all of
   them (or ship as a per-model option).
6. **Human review** decides what ships.

Track per task: pass rate, cost per passed task, time per passed task, tokens, requests, cache hit
rate. Compare harnesses only on tasks both pass in all trials. [POST methodology]

---

## 9. Build phases

| Phase | Scope | Done when |
| --- | --- | --- |
| **1. Core loop** | Daemon + `exec` stdio JSON-RPC, 1 Anthropic + 1 OpenAI adapter, direct tools (read/edit/create/execute/grep/glob), permissions + autonomy levels (§5.5), transcript persistence and settings (§12), streaming notifications (§3.1) | A scripted prompt edits a repo end to end via `exec`; same task passes on both providers |
| **2. Script mode** | Sandboxed Script tool (S1–S11), result log + search, background jobs + wake, `script_job` tool, per-model `toolExecutionMode` | A 300-call task (e.g. mass rename across files) finishes in ≤ 3 model requests; sandbox escape tests fail closed |
| **3. Cache + budget** | Append-only builder, deferred tools via `load_tools`, cache monitor, base-prompt budget test, context breakdown | ≥ 95% cache-read on a 50-turn session with a tool loaded mid-session |
| **4. Guards + compaction** | All §4.2 rules, compaction (16k reserve / 4k target), retry-on-same-provider, §4.5 routing | Fault-injection tests (silent stream, partial stream, repeat calls) each hit the defined action |
| **5. Clients** | TUI (§13), TypeScript SDK (`run`, `createSession`, `connectToDaemon`), WebSocket transport, hooks (§5.6), MCP, skills (§5.8), custom subagents (§5.9), spec mode (§5.5.7) | SDK example runs a multi-turn session with a custom MCP tool |
| **6. Eval loop** | §8 | Weekly report: per-model pass/cost/time vs previous build |
| **7. Perf** | §7 targets with CI gates | CI fails on regression of first-keystroke p95 or base-prompt size |
| **8. Desktop app** | §14 shell, §17 side pane, §19 notifications, sounds and appearance | From the app: run a session, browse and edit a file (stale write refused), use a terminal that survives a window reload, let the agent drive the browser pane, ask a side-chat question while the agent works; killing the daemon restarts it; switching theme shows no flash |
| **9. Worktrees** | §18 | Two sessions on one repo run in separate worktrees; setup profile runs with secrets stripped; auto-delete skips a worktree with uncommitted work |
| **10. Automations** | §16 | A schedule fires on time in its IANA zone; after a simulated sleep it catches up once; a webhook without the secret gets 401 and a valid one gets 202 + a run; a failed run retries once, then shows degraded |
| **11. Missions** | §15 v1 | Against a fake local model server: a 3-feature, 1-milestone mission runs to `completed` with both validators inserted; the retry limit pauses it and resume grants more attempts; a worker cannot write `features.json` |

Phases 8–11 start after phase 5 (they need the clients, MCP and skills). 9 and 10 do not depend on 8;
11 needs 9 only if missions run in worktrees. [DESIGN]

---

## 10. Unknowns after the CLI analysis

**Resolved [CLI]:**

| Question | Answer | Section |
| --- | --- | --- |
| Script sandbox engine | Separate Rust + V8 process, hash-checked | §5.2 |
| Raw-block syntax | Heredoc-style named blocks above the code, read as `inputs.<name>`; one control line for background start | §5.2 |
| Output cap sizes | 64 KiB printed text, 32 KiB per tool echo, 5 MiB / 1,024 events per Script, others in the §5.2 table | §5.2 |
| How appended tools are represented | Reminder messages; the `tools` array is not edited | §6.2 |
| Which models get Script mode | Server-side model allowlist, per-session override | §4.1 |
| Loop-guard thresholds | 3 empty turns; nudge 3 / stop 6 repeats; 24 for Script waits; 10-min response limit | §4.2 |
| 4-minute silent-stream retry | Stream idle limit for vendor-hosted Anthropic models; others use `llmRequestTimeout` (10 min default) | §4.2 |
| 16k compaction budget | Summary reserve and summarizer max output = 16,000; soft target 4,000; ceiling 40,000 | §4.4 |
| Router model selection | Client-side classifier scores candidates; cheapest with score ≥ 0.7 wins | §4.5 |

**Resolved by runtime capture [RUN]:**

| Question | Answer | Section |
| --- | --- | --- |
| Which 2 tools go up front | `Script` + `WaitForScript` (Script mode); 6 direct tools in exec read-only direct mode | §5.1 |
| First-request size and shape | ~31.9k chars (~8k tokens est.); tools are the largest part; 1-hour cache breakpoints | §6.4 |
| Compaction request `max_tokens` | 16,192 = 8,000 custom-model cap + 8,192 text headroom; 5,000 when the model sets `maxOutputTokens: 5000`; no tools; one-block summarizer prompt | §4.4 |
| 8,000-token cap for custom summarizer models | Applies whenever the custom model has no `maxOutputTokens` (logged as 8,000) | §4.4 |
| Manual compaction | `/compress` (confirm dialog); same summarizer request as automatic | §4.4 |
| Tools per autonomy level and in the interactive app | 6 / 11 / 11 / 12 / 12 (skip drops `riskLevel`) for exec; 15 interactive | §5.1 |
| Works without a Factory login | Yes, in air-gapped mode with a custom model | §0 |

**Written:**

- **Prompt text and tool descriptions.** The originals were seen in the binary and deliberately not
  copied. Original replacements are in [`prompts.md`](prompts.md): identity line, base system prompt,
  Script-mode block, context block templates, 14 tool descriptions and schemas, the summarizer prompt
  and post-compaction preamble, and loop-guard messages, with a size table. It lists the design choices
  it made where this spec is silent.

**Filled in Oct 30 (CLI code, SDK types, captures and real session files):**

| Area | Section |
| --- | --- |
| Wire message shapes, errors, handshake, all MVP methods, notifications, client requests, interrupt | §3.1 |
| OpenAI Responses / WebSocket / Chat Completions adapters, Azure, retries, Google and Bedrock | §4.6 |
| Permission and risk rules, always-allow, exec mode, spec mode, sandbox | §5.5 |
| Hooks: config, running, stdin and outcomes per event, Script interaction | §5.6 |
| Skills: locations, format, precedence, listing, Skill tool | §5.8 |
| Subagents and custom droids: files, Task tool, child sessions, limits | §5.9 |
| Session files, search index, resume, `~/.factory` layout, settings levels and keys, custom models, AGENTS.md | §12 |
| TUI layout, slash commands, keys, panels, `/context` | §13 |

**Not found (looked, not located):**

Wire protocol:
- Live `request_permission`, `ask_user` or `pick_options` traffic, and `permission_resolved`. Looked in: All 5 captures. Every run used `autoRejectPermissionRequests: true`, so the shapes above come from the SDK only.
- Live `interrupt_session` and what the CLI emits after it. Looked in: The captures have none. The CLI behaviour is [CLI-INF].
- `session_compacted`, `llm_retry`, `tool_execution_heartbeat`, hook notifications, `error` notifications, and settled tool phases. Looked in: The captures. These shapes are SDK only.
- How `warmup_cache` behaves on the server. Looked in: The SDK stubs it locally and sends nothing. The schema says `{}` → `{}`.
- What answers a pending prompt re-shown by `load_session`. Looked in: The SDK schemas list pending requests with `requestId`, but I found no separate "respond later" method in the MVP set.
- Where `CONFLICT` (-32006) is used. Looked in: It is defined in the SDK enum, but no use of it was found in the SDK client.
- The `backgroundWork` field. Looked in: Seen in [RUN] only. It is not in the SDK schema, and its meaning was not found.
- A sessionId on session-scoped requests. Looked in: None exists in the SDK or the captures (one session per process). Multi-session routing is [DESIGN].

Storage and configuration:
- **`compaction_state` in practice.** No such record appears in any real session file. Its fields come from code only.
- **`session_annotations` database.** It has a migration, but no file exists on disk.
- **"Continue last session" shortcut.** Not found: `--resume` with no id opens a picker.
- **`.bak` rule.** That `.settings.json.bak` always holds the previous version is inferred, not read directly.
- **Per-file AGENTS.md limit.** None found; only the 80,000 total and 40,000 per lazy pass.
- **Credentials file format.** `auth.v2.keyring` was not opened, by rule.

Skills, subagents and hooks:
- Exact SessionStart `source` values beyond startup, resume and compact (for example whether `clear` exists).
- The exact text and role used when a Stop hook's block reason is fed back.
- The child transcript file path pattern. Only "same sessions store, linked by parent id" was seen.
- How a user moves a foreground Task to the background, if that is possible.

Permissions, adapters and TUI:
- Gating rule for WebSearch / FetchUrl (when they ask). Looked in: Permission switch in the confirmation module; only their UI strings were found
- Whether Grep / Glob ever ask. Looked in: Same switch: only Read and LS are explicitly exempt
- Exact Ctrl+L behaviour (whether it wraps; whether it is capped by the org maximum). Partly answered: in the desktop app the autonomy chip cycles Low → Medium → High and skips Off. Ctrl+L itself was not pressed and its key handler was not traced
- Which platform maps mode-cycling to Ctrl+T. Looked in: The flag comes from a platform helper that was not resolved
- A per-command "always allow" list being used. Looked in: `addAllowedCommand` exists, but nothing calls it
- User-configurable Azure endpoint, `api-version`, or deployment mapping. Looked in: All chunks: no `api-version`, no `openai.azure.com`; `azure_openai` appears only as a proxy api-provider
- Stream idle timeout on the WebSocket path. Looked in: Only the HTTP Anthropic path's 240 s was seen; the WS idle value comes from a caller that was not traced (§4.2 already claims `llmRequestTimeout`)
- Spec-mode restriction on Execute in code. Looked in: None found; it appears to rely on the prompt
- What the custom status-line command receives on stdin. Looked in: Only the settings schema and error strings were found

**Open design decisions for Scott.** These are choices, not gaps. Each has a default in this spec, so a builder can proceed without an answer:

1. Settings set only at session start (as the SDK does) or changeable mid-session through `update_session_settings` (§3.1.5). Default: start only.
2. One session per connection (as the CLI does) or a `sessionId` on every session-scoped request (§3.1). Default: one per connection.
3. PostToolUse for tool calls inside Scripts (§5.6). Default: no; it fires once for the outer `Script` call.
4. A cap on how many times a Stop hook may send the agent back to work (§5.6). The CLI has no cap; it relies on hooks checking `stop_hook_active`. Default: no cap, as the CLI does.
5. A spec-mode rule in code that refuses `Execute` above low risk; the CLI relies on the prompt (§5.5.7). Default: prompt only.
6. Azure OpenAI as a custom `openai` provider with a user-set endpoint (§4.6.8). Default: as written there.
7. Skill tool input `{skill}` (CLI) or `{name, args}` (`prompts.md`) (§5.8). Default: `{name, args}`.

**Still not checked:**

- The purpose of the interactive app's small side request (§6.4).
- Compaction limits for vendor-hosted (non-custom) models; that needs a logged-in run.

**Cannot be settled by examining the app:**

- Whether the benchmark claims hold (vendor-reported; run your own head-to-heads). **Partly tested
  Oct 30** (the benchmark notes stay in the research folder; they are not in this repo):
  - First-request time was 632 ms median offline (the post says 646 ms).
  - A 4-run pilot on Opus 5.5 confirmed that the Script/direct switch works and that per-request
    usage can be measured.
  - Script mode used about half the credits there, but mostly because direct mode's first request
    read nothing from cache. n=1 per cell, so the 15% claim is not settled.
  - The desktop app on Auto routed both tasks to GPT-6 Luna (Azure OpenAI, xhigh, direct mode),
    passed both, and used 2,786 and 3,664 credits, about 8 to 17 times fewer than Opus 5.5 (§4.5
    router, observed live).

**Resolved from the logged-in config [LIVE]:** the Script-mode allowlist (12 top-tier models, §4.1), router
candidates (remote list empty, so the built-in 7 apply; §4.5), and the harness-related feature flags (§5.1).
Stream deadlines are partly answered: the only live control is a server-side proxy flag, and its value
is not visible.

[CLI] findings are static; [RUN] findings come from the capture described in §0. Static evidence for this pass: REA JavaScript analysis
`ev_653665c28e1975bdc83510201d911c5b046644619fcf9a29bed6741d850fc61a` (parent
`ev_21ba4db8850818c0e6ac0a182e0ff141d0f4c423a0d53170037c780cfa500b7f`). REA's data-flow graph is partial
on these large minified files, so minified names were tied to values with a separate parser-based scope
check.

**Still open after the local-product pass (§14–§19)** [UNKNOWN unless noted]:

- Missions: the exact root of the missions folder; how each role's tool list is narrowed; where the
  `start_mission_run` confirmation is shown; the plan, worker and validation screens (not opened, since a
  run would spend usage).
- Automations: how many consecutive failures trigger auto-pause.
- Desktop: whether Ctrl+N opens the model picker or a new session when both are bound; what Ctrl+L does
  from the keyboard; the file viewer's internals; the theme file format; whether a toast is skipped when
  the session is on screen; whether every IPC handler checks its sender; how the app's side chat starts
  its session (fork or fresh).
- Terminal: any per-session terminal limit. Worktrees: the setup-script shell on macOS and Linux.
- TUI: when the OSC `9;4` progress sequence fires.

## 11. Legal and naming

- The SDK is Apache-2.0: you may read and adapt its protocol shapes with attribution.
- The CLI is proprietary: build from observed behavior and your own design, not copied code or prompt
  text. The [CLI] facts here are behavior and numbers, written in this spec's own words.
- Don't use "Droid", "Factory", or their marks in your product.

---

## 12. Session storage and configuration

Tags: [RUN] seen in real files under `~/.factory` or `bench-data/app-sessions`. [CLI] read in the shipped CLI code. [CLI-INF] inferred from CLI code. [SDK] from the SDK type file. [LIVE] logged-in config cache. [DESIGN] recommendation for our build.

### 12.1 Session storage

#### Where session files live

| Path | What it is | Tag |
|---|---|---|
| `~/.factory/sessions/<slug>/<sessionId>.jsonl` | Transcript. Append-only event log. | [RUN] |
| `~/.factory/sessions/<slug>/<sessionId>.settings.json` | Per-session settings and token totals. | [RUN] |
| `~/.factory/sessions/<slug>/<sessionId>.settings.json.bak` | Previous copy of the settings file. | [RUN] |
| `~/.factory/sessions/<sessionId>.jsonl` | Old layout with no project folder ("global root"). | [CLI] |
| `~/.factory/sessions/btw/<sessionId>.jsonl` | "btw" side-question forks. | [CLI] |
| `~/.factory/sessions/<sessionId>/attachments/` | Attachments for a session. | [CLI] |
| `<transcript>.events.lock` | File lock held while appending. | [CLI] |

`sessionId` is a UUID [RUN]. The SDK lists sessions from `sessionsDir`, which defaults to `~/.factory/sessions/`. Its options are `cwd`, `fetchOutsideCWD` and `limit`, and results are sorted newest `modifiedTime` first [SDK].

**How the slug is made from the working directory** [CLI]:
1. Expand a leading `~`.
2. Make the path absolute.
3. Resolve symlinks with realpath, if the path exists.
4. Strip trailing slashes.
5. Drop the `:` after a Windows drive letter.
6. Replace each run of `/` or `\` with a single `-`.
7. Put a `-` in front.

Example: `C:\Users\scott` becomes `-C-Users-scott` [RUN]. Dots, underscores and existing dashes are kept as they are [CLI].

Because a project slug always starts with `-`, it can never clash with `btw` or with the empty root [CLI].

**Finding a session by id** [CLI]:
- Look in the current project's slug folder, then `btw/`, then (optionally) every project folder.
- Reject an id that is empty or contains `/`, `\`, `..` or NUL.
- Reject a resolved path that falls outside the sessions folder.

**Creating and appending** [CLI]:
- A new session writes its `session_start` line synchronously before anything else.
- Each append takes the `.events.lock` lock.
- If an existing file cannot be loaded at create time, it is removed and recreated.
- The reader uses 1 MiB line buffers and a 64 KiB chunk size.

[DESIGN] Keep this layout as is. Use the same slug rule so a session can always be found again from its cwd. Store the slug in the index rather than recomputing it, because realpath can change over time (see `project_key` below).

#### Transcript `.jsonl` record types

Each line is one JSON object with a `type` field. The first line must be `session_start`; the loader fails without it [CLI].

**`session_start`** (line 1)

| Field | Meaning | Tag |
|---|---|---|
| `id` | Session UUID | [RUN] |
| `title` | Session title. Defaults to "New Session". | [RUN][CLI] |
| `isSessionTitleManuallySet` | True once the user renames the session | [CLI] |
| `sessionTitleAutoStage` | Auto-title progress, e.g. `first_message` | [RUN] |
| `owner`, `organizationId` | Who owns the session | [RUN][CLI] |
| `parent` | Session this one was forked from | [CLI] |
| `callingSessionId`, `callingToolUseId` | Set on subagent sessions: the session and tool call that started them | [CLI] |
| `version` | Format version. Always `2`. | [RUN] |
| `cwd` | Working directory | [RUN] |
| `hostId` | Machine id from `~/.factory/host.json` | [CLI] |
| `privacyLevel` | Optional | [CLI] |

**`message`**

| Field | Meaning | Tag |
|---|---|---|
| `id` | Message id | [RUN] |
| `parentId` | Previous message in the chain | [RUN] |
| `timestamp` | ISO time | [RUN] |
| `seq` | Counter that goes up by one per message | [RUN] |
| `message` | `{role: "user" \| "assistant", content: [...] , ...}` | [RUN] |
| `tokens` | Optional token count | [CLI] |
| `compactionSummaryId` | Links a message to a compaction record | [CLI] |

Fields inside `message` [RUN]:
- `visibility`: `llm_only` (the model sees it, the UI hides it), `user_only` (the UI shows it, the model never gets it), or absent (both).
- `userMessageSource`: `desktop` or `sdk`.
- `interactionMode`: on user messages.
- On assistant messages: `modelId`, `apiProvider`, `routerId`, `reasoningEffort`. OpenAI turns also carry `openaiEncryptedContent`, `openaiReasoningId`, `openaiReasoningSummary`, `openaiMessageId` and `openaiPhase`, so encrypted reasoning can be replayed.

Content block types [RUN]:

| Block | Fields |
|---|---|
| `text` | `text` |
| `thinking` | `thinking`, `signature`, `signatureProvider`, `durationMs` |
| `tool_use` | `id`, `name`, `input`, optional `script_execution: {run_id, outer_tool_use_id}` |
| `tool_result` | `tool_use_id`, `is_error`, `content` (a string or a list of `text` blocks), optional `model_content` |

`model_content` is a shorter version of the result that is sent to the model; `content` is the full version shown to the user [RUN].

**How a turn is laid out** [RUN]:
1. A context message with id `context-<turnId>`, `seq` 0, `visibility: llm_only`. Its text blocks are the system reminders for that turn: the tool catalog, skills, subagents, system info, the date and session-start workspace output.
2. The user's prompt. Its id is the `turnId` and its `parentId` is the context message.
3. Assistant and tool-result messages, chained by `parentId`.
4. Inner tool calls made from inside a Script run are saved as `user_only` messages with ids `repl-tool-call:<runUuid>-<n>` and `repl-tool-result:<runUuid>-<n>`. The outer Script `tool_result` comes after them.
5. Todo nudges are `llm_only` messages with ids `todo-suggest-<uuid>`.

**Other record types**

| `type` | Fields | Tag |
|---|---|---|
| `todo_state` | `id`, `timestamp`, `todos: {todos: [{id, status, content, priority}]}`, `messageIndex` | [RUN] |
| `agent_turn_outcome` | `turnId`, `reason` (e.g. `completed`), `resultKind` (`text`, `structured` or null) | [RUN][CLI] |
| `compaction_state` | See the next table | [CLI] |

**`compaction_state`** [CLI]

| Field | Meaning |
|---|---|
| `id`, `timestamp` | Record id and time |
| `summaryText`, `summaryTokens` | The summary and its size |
| `summaryKind` | `llm_summary` (default) or `provider_switch_serialization` |
| `anchorMessage` | `{id, index}` of the last message the summary covers |
| `removedCount` | Messages replaced by the summary |
| `systemInfo`, `systemInfoText` | System info captured when the record was made |
| `loadedDeferredToolNames` | Deferred tools that were loaded and must stay loaded |
| `retainedSkills`, `retainedImages` | Skills and images carried past the cut |

Rules for compaction records [CLI]:
- Nothing is written while the transcript is frozen.
- On load, take the latest `compaction_state`, then only the messages after its anchor.
- The older messages stay in the file for the UI.
- This record was not seen in any real file [RUN: none present].

**Fork** [CLI]: copies the events up to a chosen message into a new session whose `parent` is the source. Forking at a point before a transcript-only message is an error.

**Where usage is stored**: token usage is not stored per message in the `.jsonl` (apart from the optional `tokens`). Totals live in `.settings.json` (next section) [RUN].

#### `<sessionId>.settings.json`

| Field | Meaning | Tag |
|---|---|---|
| `model` | `auto` or a model id | [RUN] |
| `reasoningEffort` | Effort level for the session | [RUN] |
| `interactionMode` | e.g. `auto` | [RUN] |
| `autonomyLevel` | e.g. `medium` | [RUN] |
| `autonomyMode` | Older combined form, e.g. `auto-medium` | [RUN] |
| `compactionThresholdCheckEnabled` | Auto-compaction on or off | [RUN] |
| `allowSubagentsInScripts` | Script runs may start subagents | [RUN] |
| `toolExecutionMode` | `direct_only` or `script_only` | [RUN] |
| `toolExecutionModeModelId` | Model that mode was chosen for | [RUN] |
| `toolExecutionModeOverride` | Optional user override | [RUN] |
| `assistantActiveTimeMs` | Total time the assistant has been working | [RUN] |
| `tokenUsage` | `{inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, thinkingTokens, factoryCredits}` for this session only | [RUN] |
| `inclusiveTokenUsage` | Same shape, including child (subagent) sessions | [RUN] |
| `childInclusiveTokenUsageBySessionId` | Map from child session id to its inclusive usage | [RUN] |
| `lastCallTokenUsage` | `{inputTokens, outputTokens, cacheReadTokens}` for the latest model call (used for context-fill display) | [RUN] |
| `effectiveFactoryRouterModel` | `{modelId, reasoningEffort, reason ("routine" or "task_fit"), fallbacks[{modelId, reasoningEffort}]}` when `model` is `auto` | [RUN] |
| `providerLock`, `providerLockTimestamp`, `apiProviderLock` | Pins the provider once a session starts so replay formats stay consistent | [RUN] |
| `tags` | `[{name, metadata}]`, e.g. `sdk {language, version}` | [RUN] |
| `archivedAt` | Set when the session is archived | [SDK][CLI] |
| `worktree`, `artifacts` | Read by the CLI and copied into the index | [CLI] |

The SDK schema for this file lets unknown fields pass through [SDK]. Saves take `{async, shouldSyncToCloud}` options [CLI].

**`.bak`**:
- In the real files, the `.bak` differs only by `assistantActiveTimeMs: 0` [RUN].
- A brand-new session with no turns has no `.bak` [RUN].
- My reading is that the `.bak` is the previous version, kept when the file is rewritten [CLI-INF].
- The CLI's general "atomic write with backup" helper writes `<file>.bak` under a lock (seen for `state/prompt-cache-keys.json`) [CLI].

[DESIGN] Write the settings file atomically (temp file, then rename). Copy the old file to `.bak` first. On a parse failure, fall back to `.bak`.

#### Local search index (SQLite)

**Files** [RUN]:
- `~/.factory/cache/session-index/index.db`, plus `-wal` and `-shm` (WAL mode).
- `.metadata_never_index`, which stops macOS Spotlight from indexing the folder.

**Ground rules** [CLI]:
- The index is a cache that can be rebuilt. The `.jsonl` and `.settings.json` files are the source of truth.
- Migrations ship as `.sql` files. A `schema_migrations` ledger records a checksum for each one.
- Migrations deliberately do not use `IF NOT EXISTS`, so a mismatch fails loudly.
- It needs SQLite 3.45 or later for JSONB.

**Tables** [RUN + CLI]

| Table | Columns (meaning) |
|---|---|
| `schema_migrations` | `version, name, checksum, applied_at`. 9 rows, from baseline to vector bookkeeping. |
| `meta` | `key, value`. Keys: `vector_epoch`, `last_integrity_check_at`, `last_full_refresh_at`, `last_full_refresh_schema_version`. |
| `sessions` | One row per session; see below. |
| `session_ingest` | Where incremental parsing stopped; see below. |
| `session_spans` | Searchable chunks of conversation text; see below. |
| `session_term_filters` | `session_id, filter` (BLOB): a bloom filter of the session's words and word prefixes, used to skip sessions quickly before a text search. |

Columns of `sessions`:
- `session_id` is the primary key.
- `project_key` is the folder relative to `sessions/`: `''` (root), `btw`, or the slug. It is stored, not recomputed, because realpath may change later.
- `cwd`, `title`.
- `org_id`, `owner`. NULL means "do not assume access".
- `parent`, `calling_session_id`, `calling_tool_use_id`, `mission`.
- `tags` is a JSONB object keyed by tag name, e.g. `{"subagent":1}`.
- `has_user_visible_messages`: NULL means unknown, which is shown; only 0 hides the session.
- `archived_at`.
- `first_event_at`, `last_event_at`: epoch ms, taken from the transcript.
- `messages_count`: every message, not only user messages.
- `host_id`, `worktree`, `artifacts`, `settings_write_seq`.

Indexes on `sessions`:
- `parent`
- `calling_session_id`
- `mission`
- `json_extract(tags,'$.subagent')`
- `(org_id, owner, project_key, last_event_at)` for the recent-sessions list

Columns of `session_ingest` (deleted along with its session):
- `transcript_mtime_ms`, `transcript_size`
- `transcript_offset`: bytes already read
- `transcript_skipped_lines`
- `transcript_messages_count`: messages before the offset
- `settings_mtime_ms`: -1 means not read yet
- `transcript_summary_fingerprint`, `schema_version`
- `span_tail_offset`, `span_tail_line`, `span_tail_index`

Columns of `session_spans`:
- `session_id`, `span_index`
- `line_start`, `line_end`: 1-based lines in the `.jsonl`
- `text`: user and assistant prose only, with system reminders removed
- `first_event_id`, `last_event_id`
- Optional embedding fields: `scale`, `vector` (int8), `text_sha256`, `embedding_space`, `synced_at`

**Triggers** [RUN]:
- `sessions_settings_rewritten` and `sessions_daemon_fields_stale` mark a row's settings as stale.
- Three triggers bump `vector_epoch` whenever spans change.

**Search** [CLI]:
- Lexical search uses the bloom filters to skip sessions, then scans `session_spans.text`.
- Semantic search uses the int8 vectors.
- Semantic search leaves out subagent sessions.
- Search is behind the feature flag `session_index_search`. The daemon's list call has a `session_index_only` mode.

**Real data** [RUN]: 13 session rows, 0 spans, 0 filters (search was off on this account).

A second database for `session_annotations` (and `session_annotation_write_clock`) has a migration, but no file for it exists on disk [CLI][RUN].

[DESIGN] For our build, the required part is the `sessions` and `session_ingest` tables, which feed a fast session picker. Spans, bloom filters and vectors are optional and should only be built if search is in scope.

#### Resume and load

**CLI flags** [CLI]:
- `-r, --resume [sessionId]`: resume by id or session link. With no id, it opens a session picker.
- `-s, --session-id <id>` (exec mode): continue an existing session; needs a prompt.
- `--fork <id>`: fork, then resume the fork.

**Load steps** [CLI]:
1. Find the file (lookup order above).
2. Read `session_start`.
3. Find the latest `compaction_state`. Rebuild the model context from its summary plus the messages after its anchor, using `parentId` to set the order.
4. Skip `user_only` messages when building the model request. Skip `llm_only` messages when drawing the UI.
5. Restore the latest `todo_state`.
6. Read `.settings.json` for the model, effort, modes and provider lock.

**Picker** [CLI]: reads the `sessions` index table for the current `project_key`, newest `last_event_at` first. Subagent sessions are hidden by tag, and so are rows where `has_user_visible_messages` is 0.

Not confirmed: whether any flag resumes the latest session without the picker. No "continue last" flag was found among the CLI option strings.

#### Other per-session state outside `sessions/`

| Path | Contents | Tag |
|---|---|---|
| `~/.factory/artifacts/scripts/<sessionId>/<toolUseId>.log` | Output log of each Script run | [RUN] |
| `~/.factory/snapshots/manifests/<sessionId>.snapshots.json` | Rewind points. `{sessionId, version, createdAt, lastAccessedAt, boundaries[{messageId, messageIndex, timestamp, files[{filePath, contentHash, size, capturedAt, toolCallId, mode}], deletions[], creations[], totalSize}], oldestAvailableBoundaryIndex, evictedBoundaryCount}` | [RUN] |
| `~/.factory/snapshots/content/<2 hex>/<rest of sha256>` | File contents stored by hash, plus `content/.metadata.json` | [RUN] |
| `~/.factory/snapshots/.index.json` | `{version, lastCleanupAt, totalSizeBytes, boundaryQueue[{sessionId, boundaryIndex, timestamp, sizeBytes, contentHashes[]}]}`: the eviction queue | [RUN] |
| `~/.factory/state/background-processes.json`, `background-tasks.json`, `task-invocations.json` | `{processes[]}`, `{tasks[]}`, `{invocations[]}` | [RUN] |

### 12.2 Configuration

#### The `~/.factory` folder

| Path | Purpose | Tag |
|---|---|---|
| `settings.json` | User settings. On this machine it holds only `trustedFolders: {"<abs path>": {trustedAt}}`. | [RUN] |
| `settings.local.json` | User settings not meant to be synced. Its values win over `settings.json`. | [CLI] |
| `mcp.json`, `hooks.json`, `update-policy.json` | MCP servers, hooks, auto-update policy | [CLI] |
| `host.json` | `{schemaVersion: 1, hostId, createdAt}` | [RUN] |
| `org-managed-settings.cache.json` (+ `.backup`) | Last org policy fetched from the server: `{orgId, userId, managedSettings, factoryTier, revision, cachedAt}` | [LIVE] |
| `auth.v2.keyring` (and other `auth.*` files) | Credentials. Not opened. | [RUN] |
| `droids/*.md` | Personal custom subagents | [RUN] |
| `skills/`, `commands/`, `plugins/` | Personal skills, commands, plugins; `plugins/sync_stamp.json` maps cwd to `{outcome, fingerprint, completedAt}` | [RUN][CLI] |
| `sessions/`, `snapshots/`, `artifacts/` | See Session storage | [RUN] |
| `cache/` | `session-index/`, `feature-flags.json`, `builtin-skills/<name>/<hash>/SKILL.md`, `connector-tool-catalogs/<sha256>.json` (`{version, revision, fetchedAt, tools[]}`), `certs/` | [RUN] |
| `state/` | Background process/task registries, `last-startup-version`, `prompt-cache-keys.json` | [RUN][CLI] |
| `bin/` | Bundled `rg.exe`, `keytar.node`, `script-runtime-<sha256>/droid-script-runtime.exe`, each with a version or hash stamp file | [RUN] |
| `logs/` | `droid-log-single.log`, `daemon-stderr.log`, `desktop-startups.log` | [RUN] |
| `telemetry/`, `crons/`, `repl-runs/`, `attention-outbox/`, `temp/` | Housekeeping | [RUN] |

[DESIGN] For our build, the required pieces are `settings.json`, `settings.local.json`, `mcp.json`, `hooks.json`, `droids/`, `skills/`, `sessions/`, `snapshots/` and a credential store. The rest is product-specific.

#### Settings levels and precedence

Layers, from highest priority to lowest [CLI]:

| Level | Source |
|---|---|
| `org` | Org settings from the server (cached in `org-managed-settings.cache.json`); org plugins |
| `runtime` | File passed with `--settings <path>`, applied to this process only (also passed on via env var `FACTORY_RUNTIME_SETTINGS_PATH`) |
| `folder` | `.factory/settings.json` in each folder between cwd and the git root; also `.agent(s)` folders and an automation skills folder |
| `project` | `<git root or cwd>/.factory/settings.json`; also project `.agent/` folder and project plugins |
| `user` | `~/.factory/settings.json`; also `~/.agent/` folder and user plugins |
| `dynamic` | Remote dynamic config |
| `builtin` | Hard-coded defaults |

**How the project and folder paths are found** [CLI]:
- **Project folder.** It is `<git root>/.factory` when inside a git repo, otherwise `<cwd>/.factory`. It is set to "no project" if that root is the home directory or contains it, so `~` is never treated as a project.
- **Folder levels.** These only apply inside a git repo. Start at cwd and walk up to the git root, which is not included. Every existing `.factory` folder on the way counts, unless it is the project folder or `~/.factory`. Nearer folders win.
- **Agent folders.** `.agents` and `.agent` are read in the same places as `.factory`, at lower priority. They contribute only skills and commands.
- **Local files.** Each level has `settings.json` and `settings.local.json`. Within a level, `.local` wins.

**What the UI shows** [CLI]: a value set at a higher level is labeled with where it came from: `[managed by org]`, `[org default]`, `[overridden by runtime --settings flag]`, `[overridden by folder]` or `[overridden by project]`.

**Org-managed settings** [CLI][LIVE]:
- Fetched from the server and cached in `~/.factory/org-managed-settings.cache.json`, with a `.backup` copy.
- A local file can be supplied instead with env var `FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH`.
- The org schema can set:
  - Session defaults and mission model settings.
  - `maxAutonomyLevel` and MCP/tool autonomy overrides.
  - Sync switches.
  - The command allow/deny/block lists.
  - `customModels` and `modelPolicy` (`allowedModelIds`, `blockedModelIds`, `allowCustomModels`, `allowedBaseUrls`, `allowAllFactoryModels`, `isFastModelsAllowed`, `requireExplicitOptInModelIds`, router BYOK flags).
  - `mcpPolicy`, `networkPolicy`, `sandbox`.
  - `hooks` and `allowManagedHooksOnly`.
  - Plugin and marketplace lists, `disabledSkills`, `env`, `sessionRetentionDays`, telemetry.
- This machine's cache holds only `modelPolicy` and `routedModelVisibilityPolicy` [LIVE].

[DESIGN] Org settings are out of scope for a single-user harness. Keep the level in the merge order as a no-op slot so policy can be added later without reshuffling.

#### User `settings.json` fields

Built-in defaults show which keys a user file may hold [CLI]:

| Key | Default / meaning |
|---|---|
| `sessionDefaultSettings` | `{model, reasoningEffort, interactionMode, autonomyLevel, autonomyMode (old), specModeModel, specModeReasoningEffort}`. Built-in defaults: effort `high`, `autonomyMode` `auto-medium`. If no settings level sets them, the code falls back to `autonomyMode` `normal` and `autonomyLevel` `off`. [CLI] |
| `modelFavorites` | List of model ids pinned in the picker |
| `missionOrchestratorModel`, `missionOrchestratorReasoningEffort`, `missionModelSettings` | Mission (multi-agent) models |
| `subagentModelSettings`, `subagentAutonomyLevel`, `subagentInheritTiers` | Light/medium/heavy task model and effort for subagents |
| `allowSubagentsInScripts` | Boolean |
| `compactionTokenLimit`, `compactionTokenLimitPerModel`, `compactionModel`, `compactionModelMode`, `compactionThresholdCheckEnabled` | Compaction controls (`compactionModelMode`: `current-model` or `factory-default`) [SDK] |
| `commandAllowlist`, `commandDenylist`, `commandBlocklist` | Shell command lists used by the risk gate |
| `customModels` | BYOK models; see below |
| `cloudSessionSync`, `cloudConfigSync`, `cloudItemPull` | Cloud sync switches |
| `enableOneHourAnthropicCaching` | Off by default |
| `includeCoAuthoredByDroid`, `enableDroidShield` | Git co-author line; secret scanning on commits |
| `runInWorktree`, `worktreeDirectory`, `worktreeAutoDeleteLimit` | Worktree mode [SDK]. Factory's CLI ignores `runInWorktree` (§18.1) [CLI] |
| `specSaveDir`, `imageGenerationModel` | Spec file folder; image model [SDK] |
| `diffMode` (`github` or unified), `todoDisplayMode` (`pinned` or inline), `toolResultDisplay` (`expanded` or compact), `outputStyle`, `showThinkingInMainView`, `streamAssistantResponses`, `theme`, `overrideTerminalColors` | Display |
| `enableCompletionBell`, `completionSound`, `awaitingInputSound`, `soundVolume`, `soundFocusMode`, `subagentSounds` | Sounds |
| `ideAutoConnect`, `keepSystemAwakeDuringMissions` | Misc |
| `trustedFolders` | `{"<abs path>": {trustedAt}}`. Folders the user has trusted, which allows project config to load from them. [RUN] |
| `hooks`, `permissionRules`, `env`, `enabledPlugins`, `disabledSkills` | Shared with the org schema |

[DESIGN] Our required subset: `sessionDefaultSettings`, the three command lists, `customModels`, the compaction keys, `subagentModelSettings`, `trustedFolders`, `hooks`, `env`. Everything else is optional UI.

#### Custom models (BYOK)

- **Where they live.** BYOK models go in the `customModels` array of `settings.json`, at the user level or in org settings [CLI].
- **How they are referenced.** By id, in one of three formats [CLI]:
  - New format: `custom:<displayName with spaces turned into dashes>-<index>`.
  - Old format: `custom:<model>`.
  - Provider-config format: `custom:<providerId>/<modelId>`.
- **Seen in a live run.** The §0 capture used `-m custom:mock-0`.

Fields of one `customModels` entry [CLI]:

| Field | Meaning |
|---|---|
| `model` | Model name sent to the API (required) |
| `id`, `index` | Assigned id and position |
| `displayName` | Name in the picker |
| `provider` | `anthropic`, `openai`, `generic-chat-completion-api` or `bedrock-converse` |
| `baseUrl` | HTTP(S) endpoint. Required unless `bedrock` is set. |
| `apiKey` | Key. Optional (omit for keyless endpoints). Placeholder values are rejected. |
| `apiKeyHelper`, `apiKeyHelperTtlMs` | Command that prints a key, and how long to cache it |
| `credentialSource` | Use a connected account plan instead of a key. Cannot be combined with `apiKey` or `apiKeyHelper`. |
| `authMode` | `bearer` (Anthropic only) or `provider-default` |
| `maxContextLimit`, `maxOutputTokens` | Token limits |
| `enableThinking`, `thinkingMaxTokens`, `reasoningEffort` | Reasoning controls |
| `extraHeaders` | Extra HTTP headers. Names must be unique ignoring case. |
| `extraArgs` | Extra request body fields |
| `noImageSupport` | Turn off image input |
| `bedrock` | AWS config. Required for `bedrock-converse`. If the auth method is `credentials-command`, `awsCredentialExport` is required. |
| `baseModelId`, `useInRouter` | Map to a built-in model so the auto-router may use it |
| `fileEditToolProfile` | `apply-patch` or `create-edit`: which file-edit tools the model gets |

**Secret fields** [SDK]: `apiKey`, `apiKeyHelper`, `extraHeaders` and its values, `bedrock.awsAuthRefresh` and `bedrock.awsCredentialExport`. They are masked when listed, and the list shows `hasApiKey` and `apiKeyMask` instead [SDK].

**Validation** happens per entry. A bad entry is flagged `isValid: false` rather than breaking the whole file [SDK].

Extra facts about these fields [CLI]:

- `apiKey` may hold `${ENV_VAR}` placeholders, which are expanded. UI placeholder text such as `sk-...` is rejected.
- `apiKeyHelperTtlMs` defaults to 300,000 ms.
- `noImageSupport` defaults to true for `generic-chat-completion-api` and false for the other providers.

For v1, support `model`, `provider`, `baseUrl`, `apiKey` (with env expansion), `extraHeaders`, `extraArgs`, `maxOutputTokens`, `maxContextLimit`, `reasoningEffort`, `noImageSupport` and `fileEditToolProfile`. [DESIGN]

[DESIGN] Store keys in the OS keychain where possible, with `apiKey` in the file as a fallback. Required providers for our build: `anthropic`, `openai` and `generic-chat-completion-api`.

#### Instruction files (AGENTS.md)

**File names**, tried in this order in each folder [CLI]:
1. `CLAUDE.md`
2. `Claude.md`
3. `AGENTS.md`
4. `Agents.md`
5. `agents.md`

Names that differ only by case count as one file. `DESIGN.md` / `Design.md` / `design.md` are handled on their own path.

**Folders searched at session start** [CLI], nearest first:
- From cwd up to the git root, when inside a repo. Outside a repo, cwd only.
- The git root is not used as the boundary if the home folder is inside it.
- The home folder itself is skipped during the walk.
- For each folder `D` visited, check `D`, `D/.factory`, `D/.agents` and `D/.agent`.
- Then, last, the personal folders `~/.factory`, `~/.agents` and `~/.agent`.
- The same file reached twice (by realpath) loads once.

**Symlink rules** [CLI]:
- A project file that is a symlink must point inside the project, at a `.md` file.
- A file must resolve inside its own folder.
- Broken links and non-regular files are skipped.
- The model is told about each skipped file with a short "not loaded: <reason>" note.
- Personal folders may link to any `.md` file.

**Size limits** [CLI]:
- 80,000 characters in total at session start.
- The file that crosses the limit is cut, if more than 200 characters of budget remain, with a truncation note. Loading then stops.
- No per-file limit was found.

**How files reach the model** [CLI]:
- Each file is added to the session-start context block, inside a `coding_guidelines` wrapper, labeled with its path.
- Personal files are labeled `~/<dir>/<file>`.

**Lazy discovery** [CLI]:
- When Read, Create or Edit touches a file in a deeper folder, the folders between the boundary and that folder are scanned for more instruction files: at most 24 folders per call and 40,000 characters per pass.
- New finds are queued and added as a reminder on the next turn.
- After compaction, the loaded set resets to the session-start set, so deeper files can be found again.

#### Custom subagents (`droids/`)

**Locations** [CLI][RUN]:
- `~/.factory/droids/<name>.md` (personal).
- `<project>/.factory/droids/<name>.md` (project).
- The SDK names the two locations `personal` and `project` [SDK].

**Format**: Markdown with YAML frontmatter [CLI]. The body is the subagent's system prompt.

| Key | Meaning |
|---|---|
| `name` | Name. Falls back to the file name. |
| `description` | When to use it (shown to the main model) |
| `model` | Model id, or `inherit` (the default) |
| `reasoningEffort` | Effort level |
| `tools` | One string or a list: the tools it may use |
| `mcpServers` | Comma-separated string or list of MCP server names |

The loader also keeps `createdAt`, `updatedAt`, `version` and the file's mtime [CLI]. Invalid frontmatter is logged and treated as empty; the file still loads [CLI].

**Real files** [RUN]: `~/.factory/droids/` holds two mission helpers. Their frontmatter uses `name`, `description` and `model`.

**Name normalization** [CLI]: lower-case, with anything other than `a-z`, `0-9` and `-` turned into `-`.

**Import from Claude Code** [CLI]: Claude Code agent files can be imported. Their model names are mapped, and unknown models become `inherit`.

Name clashes and the frontmatter fields as the Task tool uses them: §5.9.

---

## 13. TUI (v1)

### 13.1 Screen layout (top to bottom)

| Part | Contents | Source |
| --- | --- | --- |
| Header | Tagline; current folder; what loaded: Skills, MCPs, Connectors, AGENTS.md (each "Loaded" / "Not found" / "+N"); a tip; two shortcut hint lines | [CLI] |
| Transcript | User and assistant messages, tool blocks (collapsed; Ctrl+O expands), thinking (setting `showThinkingInMainView`), pinned todo list | [CLI] |
| Pending messages | "Steering messages" (sent after the next tool call) and "Queued messages" (sent when the agent finishes). Queue keys: Ctrl+R review, Ctrl+G pull the top item, Ctrl+X clear | [CLI] |
| Prompt area | Shows a permission or AskUser panel when one is active (13.4), otherwise the input box | [CLI] |
| Input box | Placeholder changes with the mode (spec: "research and plan first"). Shows `-- NORMAL --` / `-- INSERT --` with vim on. Hint while running: "Enter to steer · Ctrl+Enter to queue" | [CLI] |
| Status bar | Mode and autonomy, e.g. "Auto (Med) · allow reversible commands"; model; reasoning level; "auto-compress off" when off; a `SANDBOX` marker; "Bash mode active • Esc to exit"; running timer with **`context: N%`** | [CLI] |
| Footer | "? for help"; config-issue count pointing to `/diagnostics`; IDE hint | [CLI] |
| Custom status line | Optional. Setting `statusLine: {type:"command", command, padding?, maxRows 1–3}`. The command's output is shown; timeouts and errors show a hint to run `/statusline` | [CLI] |

**The `context: N%` figure** [CLI]:
- It is the last call's provider-reported input tokens, divided by the model's **compaction** limit.
- It shows `<1%` for tiny values.

### 13.2 Slash commands

The CLI's full list (categories as in the CLI) is in the table below. [CLI]

The "v1" column is my recommendation [DESIGN]:
- ✓ = needed for v1;
- – = depends on a feature outside v1 (vendor account, missions, Slack, IDE, and so on).

| Command | Category | One line | v1 |
| --- | --- | --- | --- |
| `/help` | meta | Help modal: keys, modes, autonomy levels | ✓ |
| `/new` (alias `/clear`) | session | Start a new session | ✓ |
| `/sessions` (alias `/resume`) | navigation | List recent sessions or resume one by id | ✓ |
| `/model` | config | Model picker | ✓ |
| `/settings` | navigation | Settings screen | ✓ |
| `/context` | diagnostics | Context usage by category (13.6) | ✓ |
| `/cost` | diagnostics | Token usage and cost | ✓ |
| `/status` | diagnostics | Version, mode, session id, folder, auth, model, data folder | ✓ |
| `/compress` | session | Summarise into a new session. Optional instructions; asks to confirm | ✓ |
| `/rewind-conversation` | session | Go back to an earlier user turn (also: double Esc on empty input) | ✓ |
| `/fork` | session | Copy this session into a new one | ✓ |
| `/rename` | session | Rename the session | ✓ |
| `/copy` | session | Copy the last assistant message | ✓ |
| `/cwd` (alias `/cd`) | config | Change the working folder | ✓ |
| `/mcp` | config | MCP server settings | ✓ |
| `/hooks` | config | Manage hooks | ✓ |
| `/skills` | config | Skills settings | ✓ |
| `/commands` | config | Manage custom slash commands | ✓ |
| `/droids` | config | Manage custom subagents | ✓ |
| `/statusline` | config | Configure the custom status line | ✓ |
| `/vim` | config | Toggle vim keys in the input | ✓ |
| `/themes` | config | Colour theme | ✓ |
| `/diagnostics` | diagnostics | Config problems and logs | ✓ |
| `/quit` (alias `/exit`) | meta | Quit | ✓ |
| `/handoff` | session | New session seeded with a summary of this one | – |
| `/btw` | session | Side question that stays out of the main transcript | – |
| `/tree` | session | Navigate the fork tree | – |
| `/pin` (alias `/favorite`), `/archive`, `/share`, `/link-work` | session | Session housekeeping, org sharing, work-item cost tracking | – |
| `/fast` | config | Fast variant of the current model (`/fast off`) | – |
| `/language` | config | UI language | – |
| `/terminal-setup`, `/ide` | config/tools | Terminal and IDE integration | – |
| `/plugins`, `/connectors` | config | Plugins; connectors and MCP | – |
| `/review` | tools | Code review of current changes | – |
| `/create-skill` | tools | Make a skill from this conversation | – |
| `/loop`, `/automations` | tools | Agent loop; scheduled automations | – |
| `/missions` (alias `/workstreams`) | tools | Missions picker | – |
| `/experiments`, `/stats`, `/limits` | tools/diag | Experiments; usage statistics; credit limits | – |
| `/readiness-report`, `/readiness-fix`, `/agent-effectiveness-report` | tools | Vendor repo and org reports | – |
| `/install-slack-app`, `/setup-incident-response` | tools | Slack features | – |
| `/account`, `/billing`, `/login`, `/logout`, `/bug` | navigation/meta | Vendor account | – (login only if the harness has accounts) |
| `/settings-debug` | diagnostics | Shown only in non-production builds | – |

- While the agent is running, the commands `/new`, `/clear`, `/compress`, `/rewind-conversation`, `/cwd` and `/logout` first ask "stop the current run?". The prompt says what will be lost. [CLI]
- Typing `/` opens the command menu: ↑↓ to move, Tab or Enter to pick, Esc to close. Custom commands and skills are listed too. [CLI]

### 13.3 Key bindings

| Key | Action | Source |
| --- | --- | --- |
| Enter | Send. While running, send as a *steer* message (delivered after the next tool call) | [CLI] |
| Ctrl+Enter | Queue (delivered when the agent finishes) | [CLI] |
| `\` + Enter | New line | [CLI] |
| Ctrl+V (Ctrl/Cmd+V) | Paste image | [CLI] |
| Esc | Cancel the current run; leave Bash mode; close a panel | [CLI] |
| Double Esc / Ctrl+C | Clear the input | [CLI] |
| Double Esc on empty input | Rewind to a previous message | [CLI] |
| ↑ / ↓ | Input history, or move between lines | [CLI] |
| `@` | File-path picker | [CLI] |
| `/` | Command menu | [CLI] |
| `!` | Toggle Bash mode (run a shell command directly) | [CLI] |
| Shift+Tab (Ctrl+T on one platform) | Cycle the interaction mode (auto ↔ spec, plus mission when enabled) | [CLI]; which platform gets Ctrl+T is [CLI-INF: probably Windows] |
| Ctrl+L | Change the autonomy level. In the desktop app, clicking the autonomy chip cycles Low → Medium → High and skips Off; whether Ctrl+L does the same is not checked | [CLI]; [WALK] |
| Tab | Cycle the reasoning level | [CLI] |
| Ctrl+N | TUI: cycle models. Factory's desktop app binds it to both the model picker and New Session (which wins: not checked); our desktop app uses it for New Session (§14.3) | [CLI]; [WALK]; [DESIGN] |
| Ctrl+O | Toggle detailed view (expand tool output and diffs) | [CLI] |
| Alt/Option+P | Full-screen plan view | [CLI] |
| Ctrl+P | Edit the input in `$EDITOR` | [CLI] |
| Ctrl+Shift+C | Copy the input | [CLI] |
| Alt/Option+X | Toggle auto-compress | [CLI] |
| Alt+↑/↓; Alt+PgUp/PgDn | Older or newer transcript page; scroll one user turn | [CLI] |
| Ctrl+J | Show or dismiss the changelog | [CLI] |
| `?` | Show or hide help | [CLI] |

### 13.4 Permission and AskUser panels

These panels replace the input box until they are answered. [CLI]

**Common to every panel** [CLI]:
- Options are numbered.
- ↑/↓ moves, Enter selects, the number keys `1–N` quick-select, Esc cancels.
- When several approvals are queued, the panel shows "Approval *i* of *n*".

**Command prompt** [CLI]:
- Shows "Command to approve" with a tag: (allowlisted), (denylisted) or none.
- Shows the full command, cut short with an "Ctrl+O to expand" note.
- Shows the risk ("low/medium/high risk") and, under "Why this needs approval:", the reason.
- Options: "Yes, allow" · "Yes, and always allow `<level>`" (hidden per 5.5.5) · "No, cancel".

**Edit / Create / ApplyPatch prompt** [CLI]:
- A header such as "Edit `<file>`".
- A diff preview, folded after N lines; Ctrl+O expands it.

**Batch prompt** [CLI]:
- "Approve N operations:", grouped under File Edits, File Creations and Commands.
- Options: "Yes, allow all" / "No, cancel all".

**MCP prompt** [CLI]:
- Shows the tool and its impact level.
- Options: allow once / always allow this tool / always allow this server / cancel.

**Sandbox violation prompt** [CLI]:
- Header "Sandbox Violation", the operation, the target, and "blocked".
- Allow-always options as in 5.5.5, plus a warning when an org rule will still deny it.

**Secret-scan prompt** [CLI]:
- "Proceed anyway" / "Proceed & report false positive" / "Cancel".

**Comments** [CLI]:
- The user can attach a comment to a denial. It reaches the model prefixed `[Comment]`.

**AskUser** [CLI]:
- The tool's input is a small text format. Each question starts with a `[question] <text>` line; add `(multi)` at the end of that line for multi-select.
- An optional `[topic] <short-name>` line follows the question.
- Each answer choice is an `[option] <text>` line.
- Limits: at most 10 questions, and 1–10 options per question. If no options are given, they default to Yes/No. Duplicate options are an error.
- It is parsed into `{index, topic, question, options[], multiSelect?}`.
- The panel shows one question at a time. Single-select: ↑/↓ and Enter. Multi-select: Space toggles, Enter confirms. Esc stops the agent.
- The tool result is a list of `{index, question, answer}`, or "No answers collected".

**ExitSpecMode** [CLI]:
- Heading "Specification for approval", then the rendered plan, then "Will save to: `<path>`".
- The options from 5.5.7.
- Ctrl+G edits the plan in `$EDITOR`.
- A comment box can be added ("Add guidance for the implementation…").

### 13.5 Spec mode in the TUI

| Step | Behaviour | Source |
| --- | --- | --- |
| Enter | Shift+Tab to `Spec`, or start with `--use-spec`. The status bar and placeholder change; the model gets a message that spec mode is active | [CLI] |
| While in spec | Write tools are blocked except in the spec folder (5.5.7); `ExitSpecMode` is available | [CLI] |
| Exit by approval | The model calls `ExitSpecMode`, the user picks an option (5.5.7), and the mode becomes `auto` at the chosen autonomy | [CLI] |
| Exit by hand | Shift+Tab back to `Auto`. Nothing is approved; the model is told the mode changed | [CLI-INF] |

### 13.6 `/context` display

[CLI], and confirmed in a captured screen [RUN].

**Top line:** the model name, then "Compaction meter *used/limit* tokens (*p*%)".
- This uses provider-reported usage and the model's compaction limit.
- Before the first response it says the meter is not available yet.

**Bar:** one 70-cell bar, coloured by category.

**Category list:** "Estimated usage by category · *used/budget* (*p*%)". The categories are:
- System prompt
- System tools
- MCP tools
- User info
- AGENTS.md
- Custom agents
- Skills
- Messages
- Estimated Free Space

**Notes and lists:**
- A note says that category totals are estimates and only the meter uses provider numbers.
- Then lists of loaded skills and custom agents, each with its token cost.
- Esc closes the view.

### 13.7 v1 cut

Build these parts [DESIGN]:
- header;
- transcript with collapsible tool blocks;
- steer/queue;
- the input box with `@`, `/` and `!`;
- the status bar with the context %;
- the permission, batch, AskUser and ExitSpecMode panels;
- the ✓ commands;
- the key table above, except the changelog key, the plan screen, and the transcript paging keys.

Leave out of v1 [DESIGN]:
- the mission-control screen (§15.8; it comes with the Missions phase, §9);
- droids view, IDE and Slack;
- the account, billing and limit screens;
- themes beyond light and dark.

## 14. Desktop app

An Electron app that is one more client of the daemon (§2). It adds windows, the sidebar, pages and the
side pane (§17); all agent work stays in the daemon. Facts are [APP] (seen in the shipped app code, read
statically) or [WALK] (seen in the running app) unless tagged. Factory's app is Electron 42.3.3.

### 14.1 Processes and transport

- Three parts: the Electron main process; a preload that exposes one narrow bridge object through
  `contextBridge`; one daemon child process (Factory: `resources/bin/droid.exe daemon`). [APP]
- **Transport:** Node child-process IPC (`--listen ipc`, `stdio: [ignore, ignore|inherit, <log file>,
  "ipc"]`, JSON serialization, hidden window). An optional WebSocket mode on `127.0.0.1` exists for
  debugging (Factory: port 37643, 41723 in dev; pick your own). The child is tied to the parent with
  `--parent-pid` on Windows and an inherited liveness fd elsewhere. [APP]
- **Supervisor:** states stopped → starting → running → stopping. Ready = an IPC message carrying pid and
  version within 30 s. In WebSocket mode, poll `GET /health` every 2 s (2 s timeout, 15 tries).
  Auto-restart up to 3 times with 2 s, 4 s, 8 s waits; the count resets on ready. Manual restart too.
  stderr goes to `~/.factory/logs/daemon-stderr.log`, rotated at 1 MB to `.old`; a crash breadcrumb goes
  to `logs/daemon-critical-error.json`. [APP]
- **Port held by an old process:** find the owner (Windows `Get-NetTCPConnection`, else `lsof`), confirm
  it is your daemon (HTTP probe or its command line), only then TERM, then KILL. [APP]
- **Start failures:** show a dialog that names the likely cause (antivirus quarantine, firewall blocking
  loopback, policy blocking the spawn, another program holding the port). [APP]
- **Broker in the main process:** several windows share one daemon. Record which window sent each
  request id and which windows subscribe to each session; send responses to the sender and session
  notifications to subscribers. Cache the last connection status and replay it to late windows. A reserved
  id prefix routes replies to the main process itself (Factory uses it for the tray). [APP]
- **Renderer ↔ main IPC:** invoke `daemon:sendMessage` (string only; anything else rejected),
  `daemon:isIpcAvailable`, `daemon:getPort`, `daemon:getTransportMode`; events `daemon:message`,
  `daemon:available`, `daemon:disconnect`; renderer ready / disconnected signals. [APP]
  [DESIGN] Check the sender frame on every handler (Factory's checks were not audited).
- **Daemon environment:** Factory passes its login key, API base URL, `TERM=xterm-256color`, a home
  override, the browser CDP values (§17.3) and turns the daemon's own self-update off. Your build has no
  product login: model keys come from BYOK config (§4.6). [APP; DESIGN]

### 14.2 Windows, menus, deep links

- Main window 1200×800 by default, bounds restored; hidden title bar with the native title-bar overlay on
  Windows and Linux, colored from the theme. New Window is supported and open windows are restored on
  launch. Renderer crash and hang events are logged. [APP]
- Packaged builds load `index.html` from the asar with hash routing. [APP]
- Single instance (`requestSingleInstanceLock`); a second launch forwards its deep link or focuses the
  window. [APP]
- **Deep links:** your own scheme (Factory's is product-named). Hosts: `mcp-callback` (MCP OAuth code and
  state, sent to the window that claimed that state; claims expire after 10 min; resend if not acked in
  5 s); anything else navigates the app to `/<host><path>`. Factory's sign-in hosts are not needed. [APP;
  DESIGN]
- **Menu** [APP; WALK]: File (New Window Ctrl+Shift+N, Settings Ctrl+,, Copy CLI install command, Check for
  Updates, Exit); Edit (standard); View (Reload, Force Reload, zoom, Full Screen F11); Window (Minimize
  Ctrl+M, Close Ctrl+W); Help (network check, Report a bug, About). Factory's code also has New Tab
  (Ctrl+T) and New Session (Ctrl+N). On Windows the menu bar is hidden and the title bar opens it.
- No global OS shortcuts; pane and palette keys are in-app bindings. [APP]
- **Tray / menu-bar item:** behind a feature flag and a `menuBarEnabled` setting in Factory. Icon
  offline / working / needs-you; tooltip counts; recent sessions; Open; Quit. **Optional (ask Scott).** [APP]

### 14.3 Shell layout and pages

- **Sidebar** [WALK]: New Session, Mission Control (§15), Automations (§16), Search; Projects list; user
  name and settings gear.
- **Projects list** [WALK]: sessions grouped by project folder (title + age). Filters: last activity,
  type, project; group by project; sort recent or manual. Row menu: Archive Project; `+` starts a session
  in that project; an add-folder button (runs the trust prompt, §5.6). Factory's "computer" filter is
  hosted; leave it out.
- **Command palette** (Ctrl+K; Search opens it) [WALK]: tabs All / Sessions / Pages / Settings / Actions;
  recent sessions across projects; create session or mission; go to Mission Control or Automations;
  toggle terminal; open tools panel; look-back filter 7d / 30d / 90d / All.
- **Home** [WALK]: composer, folder chip (search, recent projects, add project). Factory's machine chip
  (environments, cloud computers) is a later phase; show "Local" only.
- **Session screen** [WALK]: transcript rendered from §3 notifications (user bubbles; tool rows with icon,
  tool name, main argument; markdown with tables, code, links); edit diffs follow the diff settings
  (§19.4).
  - Header menu: Pin, Rename, Archive, Open terminal (§17.2), Copy working folder, Copy session id,
    Copy session link (your deep link), Copy as Markdown. Share is hosted: later phase.
  - Composer chips: attach (OS file picker; images per §3.1), model, autonomy, mode, reasoning,
    connectors, skills. Esc stops; Esc Esc clears; `?` opens Shortcuts & Modes help.
  - **Model picker:** search; "auto" first (§4.5); a pinned short list; then grouped by provider;
    unavailable models greyed. Factory shows a billing cost multiplier per model; show relative cost from
    your model table if you have one. [WALK; DESIGN]
  - **Autonomy chip:** a click cycles Low → Medium → High and skips Off; tooltips explain each level
    (§5.5). [WALK]
  - **Mode chip:** Normal, Spec (§5.5), Mission (§15). [WALK]
  - **Connectors dialog:** MCP servers with count, Refresh, Add MCP Server, and "edit `mcp.json`" (§5.7).
    Factory's hosted connector catalog is a later phase. [WALK]
  - **Skills dialog:** search; tabs All / Personal / Built-in; list plus rendered `SKILL.md` preview
    (§5.8). [WALK]
- **Shortcuts** [WALK]: toggle spec Shift+Tab, cycle reasoning Tab, cycle autonomy Ctrl+L, model selector,
  palette Ctrl+K, panes (§17). Each can be switched off in settings. Factory binds the model selector to
  Ctrl+N in settings and New Session to Ctrl+N in the menu; which wins was not checked. [DESIGN] Ctrl+N =
  New Session; give the model selector its own key.
- **Settings pages** in this build (local only): General (preferences, shortcuts, notifications and sounds
  §19), Appearance (§19.4), Session Defaults (§12.2), Missions (§15.4), Custom Models (form for §4.6),
  Worktrees (§18), Connectors (MCP only), Session Management (active / archived, search, filters, bulk
  rename / archive), Usage (local token totals; plan limits are hosted), Support (version, build,
  Electron version, copy diagnostics).
  - General preferences [WALK]: language, loading statuses, auto-open file previews, keep running with
    the screen off (`keepAwakeEnabled`). Factory's "role" field and code-provider connections are hosted.
- **Not in this build:** Factory's inbox, review, wiki, academy, analytics, evaluations, workstreams and
  org pages are hosted or later phases (§1); so are cloud sync, Members and Billing. API Keys, Secrets,
  Environments and dictation are on Scott's approval list (§1). [APP route list; DESIGN]

### 14.4 Desktop settings file

Separate from agent settings (§12.2). Keys seen [APP]: `keepAwakeEnabled`, `desktopAutoUpdateEnabled`,
`locale`, `windowZoomLevel`, `automationQuitWarningDismissed` (the "automations stop when the app quits"
warning, §16), `menuBarEnabled` (tray, optional). `remoteAccessEnabled` is hosted: later phase. Per-window
zoom is kept in `window-zoom.json`.

### 14.5 Updates and diagnostics

- Windows: Electron `autoUpdater` (Squirrel) or MSIX; Linux: a tarball checked against an embedded
  Ed25519 public key; your own update feed. `desktopAutoUpdateEnabled` turns it off. The app updates the
  bundled daemon; the daemon's self-update stays off. [APP; feed DESIGN]
- Help → network check and Report a bug. Factory sends crash reports, product metrics and feature-flag
  lookups to hosted services; this build keeps local logs only. [APP; DESIGN]

### 14.6 Security

- **Fuses** [APP]: off: RunAsNode, NODE_OPTIONS, inspect arguments; on: cookie encryption, embedded asar
  integrity, only load app from asar.
- **webPreferences:** `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: true` (browser
  pane). Factory leaves `sandbox` unset; [DESIGN] set `sandbox: true` explicitly. [APP]
- Deny every `window.open`. Open external links only for an allow-list of schemes (http(s), file, editor
  schemes such as vscode, cursor, zed, jetbrains). [APP]
- CSP both as a meta tag and as a response header; allow only your own loopback daemon port and the
  model hosts the user configured. [APP shape; host list DESIGN]

### 14.7 Renderer stack

React 19, TanStack Router and Query, Jotai, tiptap (composer), xterm.js, shiki, mermaid, KaTeX; Vite with
Electron Forge (Squirrel, MSIX, dmg, deb, zip makers); Playwright and Vitest. Factory also bundles pdf.js
and spreadsheet / slide libraries, likely for file previews (not checked). [APP]

## 15. Missions

A Mission is a long, multi-feature job. The user's session becomes the **orchestrator**: it plans with the
user, writes a file-based plan, then hands control to a local **runner** that works through the plan one
**worker** session at a time. Facts are [CLI] unless tagged. Factory has two generations; this section
specs v1. v2 ("Workstreams") is a later phase (15.10).

### 15.1 States and lifecycle

States: `planning → awaiting_input → initializing → running ⇄ orchestrator_turn → completed`, plus `paused`.

1. **Enter mission mode.** The current session is upgraded to an orchestrator session (tag role
   `orchestrator`, `interactionMode: "mission"`). If the current model is not on the mission-allowed list,
   switch to the configured orchestrator model and effort. Run the readiness check first (15.7). Factory
   also checks org mission policy and overage settings here; leave both out (hosted).
2. **Planning.** The orchestrator talks with the user (ask-user flips the state to `awaiting_input` and
   back). Planning is guided by built-in orchestrator skills [CLI names: mission-planning,
   define-mission-skills, plus two playbooks]. Which built-in skills ship is on Scott's approval list (§1).
   The model may also suggest mission mode from a normal session (a `recommend_mission {reason}`
   confirmation).
3. **ProposeMission** (needs user approval). On accept: create the mission folder, write `mission.md`
   (`# <title>` + the proposal) and `working_directory.txt`, snapshot model settings, log
   `mission_accepted`. A comment the user adds on the proposal goes back to the model as guidance. Reject
   returns `accepted: false`.
4. **Orchestrator writes the plan files** (15.2): `features.json`, `AGENTS.md`, one worker skill per
   `skillName`, `validation-contract.md`, `validation-state.json`, optional `services.yaml`, `init.sh`,
   `library/`. [CLI-INF from the run-start checks]
5. **StartMissionRun** (blocking tool call): check the run gates (15.7), set `running`, log
   `mission_run_started` (or `mission_resumed`), and run the runner until it stops. Progress streams back
   as tool status updates (15.8).
6. **Runner loop:** take the first `pending` feature in array order → spawn a worker → wait → handle its
   result → repeat. Stop on: all done (`completed`); a handoff that needs attention or a failed worker
   (`orchestrator_turn`); a pause condition (`paused`).
7. **Orchestrator turn.** StartMissionRun returns a state-specific message plus the recent handoffs. The
   orchestrator reviews them, edits `features.json` / `mission.md` or dismisses items
   (`DismissHandoffItems`), then calls StartMissionRun again. If every feature is done at the end of an
   orchestrator turn, mark the mission `completed`.

**Pause, resume, kill, crash** [CLI]:

- Pause (`P` in mission control, Ctrl+C, or quitting while running): interrupt the active worker, log
  `worker_paused` + `mission_paused`, state `paused`. Pausing during planning just goes to
  `awaiting_input`.
- Resume: the next StartMissionRun reloads the paused worker session and tells it to check git status and
  carry on (plus an optional `messageToWorker`), unless `restartFeature` is set.
- Kill worker (`droid.kill_worker_session {workerSessionId}`): log a user-kill failure, requeue the
  feature, go to `orchestrator_turn`.
- Crash recovery: on session load, a stale `running` / `initializing` / `orchestrator_turn` becomes
  `paused`. On a new run, an orphaned in-progress worker is cleaned up (`worker_failed`, orphan cleanup)
  and its feature requeued.

### 15.2 Mission folder

Location: `<product home>/missions/<orchestrator session id>/` [DESIGN]. Factory keys the folder by the
orchestrator session id; its exact root was not resolved [UNKNOWN; CLI uses a home-dir helper].

| File | Who writes | Purpose |
| --- | --- | --- |
| `state.json` | system only | `missionId` (`mis_` + 8 chars), `state`, `workingDirectory`, `createdAt`, `updatedAt`, `lastReviewedHandoffCount`, `initialFeatureCount`, `featureRetryBudgetBonus {featureId: n}` |
| `features.json` | orchestrator only | `{features: [...]}`; array order is queue order (feature fields below) |
| `progress_log.jsonl` | system only | append-only event log (15.6) |
| `handoffs.jsonl` + `handoffs/<ts>__<featureId>__<workerId>.json` | system (from EndFeatureRun) | handoff records (15.5) |
| `worker-transcripts.jsonl` | system | per-worker transcript skeletons: assistant text and tool inputs, long strings replaced by a length marker |
| `mission.md` | ProposeMission, orchestrator | title + proposal |
| `AGENTS.md` | orchestrator | rules for all workers |
| `skills/<name>/SKILL.md` | orchestrator | worker skills (one per `skillName`) |
| `validation-contract.md`, `validation-state.json`, `validation/` | orchestrator, validators | what "done" means and its status |
| `services.yaml`, `init.sh`, `library/` | orchestrator | optional environment setup and shared notes |
| `model-settings.json` | system only | per-mission model settings (15.4), merged over global settings |
| `working_directory.txt` | ProposeMission | the repo folder workers run in |

Feature fields: `id`, `description`, `skillName`, `preconditions[]`, `expectedBehavior[]`, `fulfills[]`,
`milestone`, `status` (`pending | in_progress | completed | cancelled`), `workerSessionIds[]`,
`currentWorkerSessionId`, `completedWorkerSessionId`.

A missing `state.json` reads as `planning`. Writes to mission JSON files are schema-checked; an invalid
write is refused with an example of the right shape. [CLI flag on by default; wiring CLI-INF]

### 15.3 File protection

Every file tool (read, edit, create, apply-patch…) checks paths before acting. Resolve symlinks, refuse a
path whose symlink cannot be resolved, and test both the given and the real path. [CLI]

- `state.json`, `progress_log.jsonl`, `model-settings.json`: no agent may read or write them through tools.
- `features.json`: refused when the caller's tag role is `worker` (workers and validators report only
  through EndFeatureRun).

### 15.4 Roles, workers and models

- Roles come from the session tag `{role: orchestrator | worker, missionId}`. A worker whose skill is
  `scrutiny-validator` or `user-testing-validator` is a validation worker; others are implementation
  workers.
- **Spawning:** each worker is a new headless session started through the local daemon with:
  `cwd` = the mission working folder, `interactionMode: "auto"`, `autonomyLevel: "high"`,
  `autoRejectPermissionRequests: true` (no approval prompts reach the user; anything that would ask is
  refused), the chosen model and effort, an inactivity timeout, tags `exec` + the mission role tag.
- **Context:** a generated first message names the mission folder, the assigned feature, the worker's
  session id, the skill to load and the rule that it must finish with EndFeatureRun. Workers read
  `mission.md`, `AGENTS.md` and their `SKILL.md` from disk. Write your own first-message text.
  [CLI-INF; text not copied]
- The orchestrator is told not to use subagents for implementation work.
- **Concurrency:** one worker at a time per mission. Several missions in different sessions can run at
  once; the `start_mission_run` confirmation carries `runningMissionCount` and `runningMissionSessionIds`.
  [CLI schema; where it is shown: not checked]
- **Models** (`missionSettings` in session settings): `workerModel`, `workerReasoningEffort`,
  `validationWorkerModel`, `validationWorkerReasoningEffort`, `skipScrutiny`, `skipUserTesting`.
  Validators use the validation pair. Log any model substitution (`substitutedFromModelId`).
  Factory's org model-policy check is hosted; leave it out.
- Per-role tool filtering: how Factory narrows each role's tool list was not checked [UNKNOWN].
  [DESIGN] Give orchestrators the four orchestrator tools and workers only EndFeatureRun from 15.5;
  EndFeatureRun already refuses any caller that is not the current worker of an in-progress feature [CLI].

### 15.5 Mission tools

| Tool | Who | Does | Inputs → outputs |
| --- | --- | --- | --- |
| `ProposeMission` | orchestrator | submit the plan for approval | `title`, markdown `proposal`, `workingDirectory?` → `accepted`, `missionDir`, `isEdited`, guidance |
| `StartMissionRun` | orchestrator | run or resume the queue; blocks | `message?`, `resumeWorkerSessionId?`, `restartFeature?`, `messageToWorker?` → started, handoffs, latest handoff, system message, `pauseReason`, counts, progress snapshot |
| `DismissHandoffItems` | orchestrator | dismiss issues or undone work, each with a justification (minimum length) | dismissals → logs `handoff_items_dismissed` |
| `EndFeatureRun` | worker | record the result and handoff | `successState`, `returnToOrchestrator`, `featureId?`, `commitId?`, `repoPath?`, `validatorsPassed?`, `handoff` → `nextAction: continue | orchestrator | completed` |

Proposal sections the tool asks for (paraphrased): overview; expected behavior by milestone and feature;
architecture; environment setup; infrastructure (services, ports, boundaries); testing strategy;
user-testing strategy; mission readiness; non-functional requirements.

**Handoff** (`handoff` field and handoff record):

- `salientSummary` (1–6 sentences, one line), `whatWasImplemented` (minimum length), `whatWasLeftUndone`
- `verification {commandsRun[{command, exitCode, observation}], interactiveChecks?[{action, observed}]}`
- `tests {added[{file, cases[{name, verifies}]}], updated?[], coverage}`
- `discoveredIssues[{severity: blocking | non_blocking | suggestion, description, suggestedFix?}]`
- `skillFeedback? {followedProcedure, deviations[{step, whatIDidInstead, why}], suggestedChanges?}`
- Record wrapper: `timestamp`, `workerSessionId`, `featureId`, `milestone`, `commitId`, `repoPath`,
  `successState` (`success | partial | failure`), `returnToOrchestrator`.

Dismissable item types: `discovered_issue | critical_context | incomplete_work`.

**EndFeatureRun rules:** `commitId` needs `repoPath` (default: the working folder); `success` needs
`validatorsPassed: true`. Success → feature `completed` and moved to the bottom of the array; otherwise
back to `pending`. Issues, undone work, `partial` / `failure`, or `returnToOrchestrator` → go to
`orchestrator_turn`.

### 15.6 Progress log and watchdog

Event types (each line has `timestamp` + `type`): `mission_accepted {title}`, `mission_paused
{pauseReason?}`, `mission_resumed {resumeWorkerSessionId?}`, `mission_run_started`, `worker_started
{workerSessionId, featureId, modelId, substitutedFromModelId?}`, `worker_selected_feature`,
`worker_completed {...handoff, exitCode}`, `worker_failed {failureReason?}`, `worker_paused`,
`handoff_items_dismissed {dismissals[]}`, `milestone_validation_triggered {milestone}`.

- **Heartbeat** every 180 s: emit `mission_heartbeat`, touch the state.
- **Stall:** a worker silent for 600 s (configurable; Factory's env `MISSION_WORKER_INACTIVITY_TIMEOUT_MS`)
  is failed. A worker that never starts gets inactivity + 300 s. Any worker notification resets the timer.
- **Completion:** watch worker notifications and the log for that worker's `worker_completed`, then close
  the worker session. Exit without a handoff → requeue, `orchestrator_turn` (suggest resume). Crash →
  `worker_failed`, requeue, `orchestrator_turn`.
- **Retry budget:** attempts = number of `workerSessionIds` on the feature; limit 5 +
  `featureRetryBudgetBonus`. Over the limit → pause `feature_retry_limit_exceeded`. Resuming from that
  pause gives every exhausted feature 5 more.
- **Scope growth:** if non-validator, non-cancelled features exceed 4 × `initialFeatureCount` **and** at
  least 25 were added → pause `scope_growth_limit_exceeded` (once).
- **Out of credits:** Factory pauses on HTTP 402 (`unrecoverable_usage_402`). [DESIGN] Pause the same way
  on a provider billing / quota error that will not clear by retrying (§4 error classes).
- **Token use:** sum usage over the orchestrator and every worker session from local session records;
  cache totals for finished workers.
- **Wake lock** while a mission runs, ref-counted, released with terminate then kill after 2 s:
  macOS `caffeinate -i -w <pid>`; Linux `systemd-inhibit` (sleep, idle, lid), else
  `gnome-session-inhibit`, exiting when the parent dies; Windows a PowerShell loop calling
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.

### 15.7 Gates

**Readiness check (entering mission mode).** A warning, never a hard block. [CLI]

- Skip if this folder's real path is in the acknowledged list (`mission-readiness-warnings-shown.json`,
  `{version: 1, folders: [...]}`, atomic write).
- Check with git (5 s timeout each): inside a work tree? has `origin`? top-level folder. An empty folder
  (ignoring `.git`) passes.
- Read `<repo>/.factory/readiness-report.json` if its repo URL matches. Factory then asks its cloud;
  your build uses the local file only. [DESIGN]
- Results: `ok | no_git | no_remote | no_report | low_score`. OK needs level ≥ 4. Errors and timeouts
  count as OK.
- A non-OK result offers: continue (remember this folder), or run the readiness-report / readiness-fix
  commands. Whether those commands ship is part of the built-in skills decision (§1).

**Run gates (StartMissionRun)** [CLI]: mission folder exists; at least one feature;
`validation-contract.md` and `validation-state.json` exist; every non-validator `skillName` has
`skills/<name>/SKILL.md` in the mission folder with valid frontmatter, enabled and unique (repo and user
skills do not count); **handoff gate**: if the last handoff has issues or undone work, refuse until a
later `handoff_items_dismissed` entry exists or `features.json` / `mission.md` changed after it; the
scope-growth check.

**Milestone validation.** When every implementation feature of a milestone is complete and no
validation ran for it yet, insert two features at the top of the queue: `scrutiny-validator-<m>` (runs
first), then `user-testing-validator-<m>`. Each can be skipped with `skipScrutiny` / `skipUserTesting`.
Log `milestone_validation_triggered`.

### 15.8 Protocol and UI

- No mission-specific session methods except `droid.kill_worker_session {workerSessionId}`. Missions use
  the normal session methods (§3), `update_session_settings` with `missionSettings`, and
  `request_permission` for approvals.
- Notifications inside `session_notification`: `mission_state_changed {state, updatedAt?}`,
  `mission_features_changed {features}`, `mission_progress_entry {progressLog}`,
  `mission_heartbeat {timestamp}`, `mission_worker_started {workerSessionId}`,
  `mission_worker_completed {workerSessionId, exitCode}`.
- Confirmation types: `propose_mission {proposal, title?}`, `recommend_mission {reason}`,
  `start_mission_run {runningMissionCount, runningMissionSessionIds}`.
- Progress snapshot (StartMissionRun status update): `state`, `updatedAt`, `activeTime {elapsedMs,
  measuredAtMs}`, `counts {total, completed, cancelled, estimatedValidation}`,
  `featureWindow {previous, focus, next}`, `currentWorkerId`.
- **Mission control (TUI):** views main, features, workers, models, feature detail, live worker
  transcript, handoff viewer. Keys: `F` features, `W` workers, `M` models, `P` pause, `R` resume, `D` open
  the mission folder, `Ctrl+T` back to the orchestrator, `Ctrl+G` close. Worker activity: starting,
  running tool, waiting, waiting for approval, compacting, delayed. A banner explains the pause reason.
  Factory's header shows credit and rate-limit use; show local token totals instead. [DESIGN]
- **Desktop app:** the Missions page and settings (§14) use the same data and notifications.
  Mission notifications for the OS are in §19.

### 15.9 Local vs hosted

Everything in 15.1–15.8 runs locally except model calls. Left out as hosted: org mission policy and
overage checks, org model policy, the cloud readiness-report lookup, cloud sync of mission metadata,
feature flags. [CLI]

### 15.10 Later phase: v2 "Workstreams"

Behind feature flags that are off by default in this build [CLI]. An orchestrator spawns and messages
many agents at once (`SpawnAgent`, `ListAgents`, `SendMessage`, `InterruptAgent`, `RenameAgent`,
`ArchiveAgent`, `CreateListener`, `ProposeWorkstream`), optionally on other machines, sharing state
through a cloud "shared space". A local version would need a local shared folder and roster in place of
the cloud parts [CLI-INF]. Not in this build; needs Scott's approval to schedule.

## 16. Local automations and crons

Two separate systems, as in Factory's CLI [CLI]:

- **Automations**: a saved prompt in its own folder, run unattended in a fresh headless session on a
  schedule (and, in this build, a local webhook). Run by the daemon.
- **Crons**: a lightweight repeater that injects a prompt into one live session (`/loop`, the `Loop` tool).

Automations only run while the daemon is running (desktop app open, or `droid daemon` in Factory). A plain
`exec` or TUI session without the daemon does not schedule anything. Say this in the UI. [CLI; Factory's
app shows the same note]

### 16.1 Automation folder [CLI]

Paths below are Factory's [CLI]; use your own product folder name in place of `.factory` (§11).

One folder per automation. Two roots: `<project>/.factory/automations/<id>/` and
`~/.factory/automations/<id>/`. Project wins on an id clash. The scan skips the project root when it is
the home folder.

| Path | Purpose |
| --- | --- |
| `HEARTBEAT.md` | Required. YAML frontmatter + markdown body; the body is the run prompt |
| `memory/` | Notes the agent keeps between runs |
| `memory/state.json` | Durable UUID, `lastRunAt`, `lastRunId`, `lastRunSessionId`, `lastRunStatus`, `runCount` |
| `memory/runs.json` | Last 50 run records: `runId`, `sessionId`, `status`, `failureReason`, `errorMessage`, `hadAssistantResponse`, `modelFallback` |
| `reports/` | Per-run output files (`<timestamp>-run-<n>.md`) |
| `skills/<name>/SKILL.md` | Skills loaded only for this automation's runs (§5.8 automation bucket) |
| `secrets.json` | Local values for this automation; never logged or sent anywhere |
| `VISUAL.html` | Optional per-automation dashboard page (see 16.8) |

Frontmatter: required `name`, `schedule`. Optional `description`, `model`, `reasoningEffort`,
`workingDirectory`, `paused`, `tags`, `targetSessionId`, `trigger` (`schedule` or `webhook`). [CLI fields,
trimmed to the local ones]

Rules [CLI]:

- The UUID lives in `memory/state.json` and wins over frontmatter. An `id` found in frontmatter is moved
  there. If `state.json` exists but cannot be read, report the automation as broken; do not mint a new id.
- Invalid automations (`missing_file`, `invalid_frontmatter`, `invalid_schedule`, `parse_error`) are still
  listed with `isValid:false`, but never run.
- All writes are atomic (temp file + rename). Refuse symlinked automation folders.
- Creating an automation writes the folder and does **not** start a run.

### 16.2 Schedules

| Form | Example | Notes |
| --- | --- | --- |
| Preset | `hourly`, `daily`, `weekly`, `monthly` | Factory: daily/weekly/monthly at 09:00 UTC; weekly on Monday; monthly on the 1st [CLI] |
| Cron | `0 9 * * 1-5` | 5 fields, month and day names, 7 = Sunday; if both day-of-month and day-of-week are set, either matches [CLI] |
| Natural language | `every weekday at 9am` | Parsed to cron once at save time; no time given means 09:00 [CLI] |

Time zone: Factory evaluates everything in UTC and turns a named zone into a fixed offset at save time,
so a "9am PST" schedule drifts an hour at a DST change [CLI-INF]. **Your build:** store an IANA zone with
each automation (default: the machine's zone) and evaluate cron in that zone. [DESIGN]

`nextRunAt` = scan forward minute by minute, up to 366 days; none when paused. [CLI]

### 16.3 Scheduler loop [CLI]

- Tick every 60 s. At most 2 dispatches per tick and 3 runs at once. One run per automation at a time
  (a second dispatch fails with "already running").
- Each tick: run due retries, list automations, skip paused / running / invalid ones, then dispatch those
  whose cron matches the current minute.
- **Catch-up:** if not due now, take an anchor (`lastRunAt`, else the folder's creation time). If the first
  scheduled time after the anchor has passed, run **once**. Never replay each missed slot. Record
  `catchUp`, `scheduledFor`, `missedSlots` on the run.
- Write `lastRunAt` right after dispatch, and skip a second dispatch in the same minute.
- **Sleep:** a gap of more than 150 s between ticks means the machine slept. After resume, wait 150 s
  before dispatching. Time asleep does not count toward a run's maximum duration.
- **Crash recovery:** write `~/.factory/run-state/<automationId>.json` while a run is in progress. Any left
  at daemon start are marked interrupted (`daemon_restarted`).
- **Auto-pause** after 10 days of missed runs or repeated failures. [CLI enum `missed_runs`,
  `consecutive_failures`; the failure count is not checked]

### 16.4 Running one automation

1. New headless session, title `[Automation] <name>`, tagged with the automation id and trigger. [CLI]
   If `targetSessionId` is set, add the prompt as a user message to that session instead (load it if it is
   not live; use that session's model). [CLI]
2. Working folder: `workingDirectory` if valid, else the automation's own folder. No worktree. [CLI]
3. Model: resolve the configured model; if it does not resolve, use the default model and record
   `modelFallback` with a reason. [CLI]
4. Permissions. Factory runs with `autonomyLevel: high` **and** skip-all-permissions [CLI].
   **Your build** [DESIGN]: autonomy `high` by default (configurable per automation), never the
   skip-all-permissions mode. Anything that would ask the user is denied and logged, and the run carries on.
   MCP servers must finish loading first; if one fails, flag the run `mcp_unavailable`.
5. Prompt: a short preamble in your own words (finish in this one turn; say what triggered you; keep
   notes in `memory/`, output in `reports/`; do not edit `HEARTBEAT.md`), then the body, then trigger
   context (webhook payload) when present. [CLI shape; write your own text]
6. Limits: 3 min to start the session, 6 h maximum run, close the session 15 s after the agent goes idle. [CLI]
7. Outcome from session notifications: `agent_turn_completed` with `completed` (or a spec hand-off) is
   success; any other reason or an `error` is failure; a timeout error maps to `model_timed_out`. [CLI]

**Retry:** one retry 5 minutes after a failure. If the retry also fails, status becomes `degraded`; the
next success clears it. [CLI]

Run statuses: `in_progress | success | failure | cancelled`. Failure reasons: `dispatch_timed_out`,
`automation_files_missing`, `host_resources`, `dispatch_exception`, `agent_error`, `model_timed_out`,
`mcp_unavailable`, `host_slept`, `daemon_restarted`, `session_closed_by_user`,
`closed_before_completion`. [CLI]

### 16.5 Local webhook trigger [DESIGN]

Factory hosts webhook receivers in its cloud; local automations there accept only schedule triggers
(local create rejects webhook with "must be created remotely") [CLI]. Scott's scope includes local
webhooks, so this part is your own design:

- The daemon serves `POST /hooks/<automationUuid>` on `127.0.0.1` (port in settings). Off unless at least
  one automation has `trigger: webhook`. Binding to other interfaces is an explicit setting.
- Each webhook automation has a random secret in `secrets.json`. Callers send it as a bearer token or an
  HMAC-SHA256 signature header; anything else gets 401.
- Copy Factory's delivery controls [CLI field names]: `payloadRegex` (only matching bodies run),
  `maxRunsPerHour` cap, dedupe of identical bodies within a short window, and a "rotate secret" action.
  Record each delivery as `accepted | filtered | deduped | capped | unauthorized`.
- Body cap 256 KB. The payload is passed to the run as trigger context, marked as untrusted data.
- Return 202 with the `runId` at once; the run goes through 16.4.

### 16.6 Crons (session repeaters) [CLI]

- One JSON file per cron under `~/.factory/crons/<scope>/<sessionId>/<id>.json`. Fields: `id` (8 hex),
  `status` (`active | held | paused | running | error | expired | cancelled`), `source`
  (`loop_command | cron_tool`), `kind: session_prompt`, `schedule {expression, recurring, nextRunAt}`,
  `stats {fireCount, lastRunAt, lastError}`. Delete = status `cancelled`.
- A cron fires only while its session has a live client in this daemon; otherwise the tick is skipped
  (`held`). If the last injected prompt is still queued, skip the tick. Never queue two.
- A fire more than 30 s late is skipped (one-shot crons expire instead). No catch-up.
- Firing = `add_user_message` with `userMessageSource: "automation"`. `fireCount` goes up only when the
  prompt was queued.
- `/loop 30m <prompt>`, `/loop <prompt> every 2h`, `/loop stop [id|all]`, `/loop list`. Interval 1 min to
  24 h, only steps that map to exact cron (minutes 1,2,3,4,5,6,10,12,15,20,30; hours 1,2,3,4,6,8,12,24),
  anchored to the creation minute. No prompt given: use `loop.md` from the project, then home.
- Factory's schema also has root crons that open a new session; they are switched off in its build. Leave
  them out. [CLI]

### 16.7 Surfaces

- Agent tools: `CreateAutomation`, `ListAutomations`, `ReadAutomation`, `EditAutomation`,
  `DeleteAutomation`, `RunAutomation`, plus `Loop`. Deferred tools (§6.2). [CLI names]
- Daemon JSON-RPC (prefix `daemon.`): `list_automations`, `create_automation`, `update_automation`,
  `delete_automation`, `rename_automation`, `pause_automation`, `resume_automation`, `run_automation`,
  `get_automation_history`; `list_crons`, `create_cron`, `update_cron`, `delete_cron`; notification
  `cron.state_changed`. [CLI]
- `/automations` in the TUI; Automations page in the desktop app (§14): list active/paused, create (name,
  schedule preset or custom, instructions), detail (status, schedule, last/next run, recent runs with
  duration, open run session), pause/resume, run now. [CLI modal; WALK]

### 16.8 Optional and out

- **Optional (ask Scott):** `VISUAL.html` per-automation dashboard the agent maintains, themed by a
  `postMessage`; the guided-setup "create" session that builds an automation by chatting.
- **Needs approval:** template content. Factory's CLI bundles one template; the app shows 16, served
  from elsewhere [CLI; WALK]. Which templates to ship, if any, is Scott's call.
- **Later (hosted):** cloud sync of automations, Slack / GitHub / CI / chained triggers, remote runs.

## 17. Side pane: Files, Terminal, Browser, Side chat

A pane beside the session with four tabs. Keys [WALK]: Files Ctrl+P, Terminal Ctrl+J, Browser
Shift+Ctrl+B, Side chat Alt+Ctrl+S; the palette's "Open Tools Panel" is Alt+Ctrl+B. The daemon owns files,
terminals and side-chat sessions; the desktop app owns the browser. Facts are [CLI] (daemon code) or
[APP] (desktop code) unless tagged.

### 17.1 Files

- `daemon.list_files {sessionId, path?, showHidden?}`: ripgrep listing, at most 25,000 files (4 MB of
  names). `path` must be relative (no leading `/`, drive letter, `.` or `..`) and resolve inside the
  session's real cwd. Hidden files off by default. A failed listing returns an empty list. Returns
  `{files[], totalFiles?, truncated?, directories?, completeDepth?}`. [CLI]
- `daemon.search_files {sessionId, cwd?, query, maxResults = 60, showHidden}` → `{files, totalFiles}`. [CLI]
- `daemon.get_workspace_file_content {sessionId, cwd?, filePath, metadataOnly?, allowDirectory?,
  encoding: utf8 | base64}`: 15 MB cap; binary files return `isBinary` with no content; returns
  `mimeType` and a sha256 `fingerprint`. The session owner may read outside the cwd. [CLI]
- `daemon.write_workspace_file_content {sessionId, cwd?, filePath, content, baseFingerprint?}`: 15 MB cap;
  refuses binary files; existing files only [CLI-INF]; if `baseFingerprint` no longer matches, fail with
  `-32006` (file changed since the edit started). Returns `{byteLength, fingerprint}`. [CLI]
- UI [WALK]: tree with search and a settings gear, file viewer, "Open in <editor>" with an editor
  dropdown (uses the external-scheme allow-list, §14.6). Viewer internals were not checked; [DESIGN]
  minimum: code with syntax highlighting, rendered markdown, images.
- Branch-wide diff RPCs (`daemon.get_git_diff`, `get_git_diff_file_contents`) back Factory's review
  screen, which stays out (§1). [CLI]

### 17.2 Terminal

- PTY in the daemon, not Electron: Factory uses `bun-pty` (a Rust PTY via FFI); read 4 KB at a time;
  default 80×24; `TERM=xterm-256color`. Rendered in the app with xterm.js. [CLI; APP]
- **Shell allow-list:** bash, sh, zsh, dash (under /bin or /usr/bin), cmd.exe, powershell.exe, pwsh.exe
  (Windows compares the file name only). Anything else is logged and replaced by the default (cmd.exe on
  Windows, zsh on macOS, bash on Linux). [CLI]
- **Environment:** the login-shell environment plus caller values, except protected keys that callers
  cannot set: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `TMPDIR`, `SUDO_USER`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`. An invalid cwd is
  error `-32602` with `reason: not_found`. [CLI]
- **Reattach:** each PTY feeds a headless xterm (scrollback 50,000) so a client can repaint after a
  reconnect. [CLI]
- **RPC** (every call also carries `sessionId`) [CLI]:
  - `daemon.create_terminal {terminalId, cols?, rows?, cwd?, env?}` → `{success}` or
    `{success: false, error}` (`TerminalIdExists` on a duplicate id).
  - `daemon.write_terminal_data {terminalId, data}`, `daemon.resize_terminal {terminalId, cols, rows}`,
    `daemon.close_terminal {terminalId}` → `{success}`.
  - `daemon.list_terminals {}` → `{terminals[{id, pid, cols, rows, createdAt, state?{serialized,
    plainText, cols, rows, timestamp, cursorHidden?}}]}`; first adopts this session's terminals that have
    no owner.
  - Output and exit arrive as `daemon.session_notification` with `type: "daemon.terminal_data"
    {terminalId, data}` or `"daemon.terminal_exit" {terminalId, exitCode, signal}`.
- **Ownership and cleanup:** write, resize and close need the owning connection. A dropped connection
  starts a 30 s grace timer per terminal; reattaching cancels it, otherwise the terminal is killed. An
  orphan sweep every 30 min kills unowned terminals. Daemon shutdown closes all. No per-session limit was
  seen (not checked). [CLI]

### 17.3 Browser

- An Electron `<webview>` on its own persistent partition (Factory: `persist:browserpanel`). The main
  process decides permissions per origin (allow / deny / prompt) and denies device permissions. [APP]
- A localhost proxy maps dev-server URLs; local names are `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`. [APP]
- Tabs (new, close, next, previous, back, forward, reopen, move), screenshot, clear cache and cookies.
  [APP] Factory can also import Chrome cookies: **optional (ask Scott)**, since it reads another
  browser's sign-ins.
- **Agent control:** when a webview attaches, register its webContents with a loopback CDP proxy
  (`webContents.debugger.attach`) and pass its `ws://127.0.0.1:<port>/devtools/browser/<id>` URL to the
  daemon in the agent's environment (your own variable names). [APP]
- The agent side accepts the URL only if: scheme `ws`, host `127.0.0.1`, port equal to the desktop's
  port, path `/devtools/browser/<id>`, no credentials or hash. It tags the URL with the root session and,
  for subagents, the agent session so the app can map tabs to sessions. Idle timeout 30 min. Commands that
  try to change the CDP target or profile skip the tagging. [CLI]
- The agent drives the browser through a browser-automation tool (Factory: the agent-browser skill with
  a bundled CLI). Whether that skill ships is part of the built-in skills decision (§1). [CLI]
- Not this pane: Factory's `daemon.desktop.*` methods are a VNC viewer for cloud machines (later phase).
  [CLI]

### 17.4 Side chat

Ask a question without interrupting the main session. [CLI unless tagged]

- **Entry:** `/btw <question>` (runs even while the agent is busy) and, in the app, an "ask side chat"
  quote-reply action on a message. [CLI; APP]
- **Fork:** on the first question, fork the main session from its **last settled point** into a hidden
  session tagged `btw-fork`, stored in `~/.factory/sessions/btw/<id>.jsonl` + `<id>.settings.json`,
  reusing the main session's prompt-cache key (§6). The daemon's fork RPC takes the same path when the
  requested tags include `btw-fork`.
- **Behavior:** a short preamble in your own words: it is a separate copy; the main agent keeps working
  and cannot see it; answer from the conversation and read-only checks; no edits or state-changing
  commands unless the user asks in the side chat; no ask-user tool. No title generation.
  Factory enforces read-only by prompt only; [DESIGN] also gate write tools in the fork unless the user
  turns them on.
- **Earlier exchanges:** tag metadata `priorExchanges`, up to 10 Q/A pairs (question ≤ 1000 chars,
  answer ≤ 4000), injected as possibly stale context. Redact tag metadata in logs.
- **Results:** nothing is written to the main transcript. Stream `assistant_text_delta` into pane entries
  `{id, question, answer, status: pending | streaming | complete | error, createdAt}`; several questions
  can queue; handle retracted messages. An entry is complete when the fork goes idle. Close the fork when
  no questions are pending.
- **Promote:** removing the `btw-fork` tag moves the files into the project's session folder and makes it
  a normal session. Session lists hide forks unless `includeBtwForks` is set.

## 18. Git worktrees

A session can run in its own git worktree and branch, so several sessions can work on one repo at once.
The daemon owns all worktree work. Facts are [CLI] unless tagged.

### 18.1 When one is made

- Only when the create-session request asks: `worktree: true`, plus `worktreeLifecycle`
  (`ephemeral` default | `persistent`), `worktreeBranchMode` (`copy` default | `existing`),
  `worktreeBaseBranch`, `worktreeNewBranch`, `worktreeSetupProfileId`, `pullFromOrigin`.
- Without it, if the cwd already is a managed worktree, the session adopts it.
- The setting `runInWorktree` (§12.2) is accepted and **ignored** in this build; the choice is per session.
  Your build can use it as the default for the "new session in worktree" toggle. [DESIGN]

Steps: take a creation slot → fetch base from origin (optional) → `git worktree add` → copy
`.worktreeinclude` files → mark the folder trusted → start the session with the worktree as cwd → save
`lifecycle`, `repoRoot`, `setupProfileId` in session settings → run the setup profile, then its initial
prompt. If session start fails, remove the new worktree (running the profile's cleanup script first).

### 18.2 Location and names

- Root `~/.factory/worktrees` (setting `worktreeDirectory`, absolute paths only; a relative value is
  ignored with a warning). Layout `<root>/<last 8 chars of session id>/<repo folder name>`. Characters
  outside `[A-Za-z0-9._-]` become `-`.
- If the root is inside the repo, tell the user to add it to `.gitignore`.
- Branch for `copy` mode: prefix + slug of the first prompt (up to 5 words, padded to 3), whole name at
  most 32 chars, `-2`, `-3`… on a clash (up to 100). Factory's prefix is `droid/`; use your own. No
  prompt: `<current branch>-wt`. Command: `git worktree add -b <branch> --no-track <path> <base>`.
- `existing` mode checks out a named branch. Refuse the repo's default branch (`root_branch`) and a
  branch already checked out elsewhere (`branch_occupied`). It can create a local branch from a remote ref.
- **Rename after title:** when the session gets its generated title, rename a generated branch to a slug
  of the title, unless it has commits found nowhere else, has an upstream, or the user picked it.
- Checkout timeout 10 min: then kill git and roll back the folder and the new branch. Run git
  non-interactive with `LC_ALL=C`.

### 18.3 Setup: `.worktreeinclude` and setup profiles

**`.worktreeinclude`** at the repo root lists gitignored files to copy into new worktrees (`.env`, local
config). At most 64 KB / 500 lines, `#` comments, relative paths inside the repo only. Copy only paths
`git check-ignore` confirms are ignored; skip symlinks; never overwrite; refuse anything whose real path
leaves the repo. If copying fails, remove the worktree.

**Setup profiles**: `name` (1–100 chars) and at least one of `script`, `initialPrompt`, `cleanupScript`
(each ≤ 100k chars).

| Source | Where | Rules |
| --- | --- | --- |
| Repository | `<repo>/.factory/worktree-setups/*.yaml` | ≤ 50 files, 256 KB each; read-only from the app; **run only if the repo folder is trusted** |
| Local | `~/.factory/worktree-setups/<sha256(repoRoot)>/*.yaml` + `index.yaml` (`lastUsedProfileId`) | Written by the user, no trust check; folders 0700, files 0600; deleted profiles keep only name + cleanup script so old worktrees can still be cleaned |

Running a script: in the worktree folder (Windows: `powershell.exe -NoProfile -NonInteractive -Command`;
other OSes not checked); login-shell PATH; **secrets stripped** from the environment (product-prefixed
vars, any name with TOKEN / SECRET / PASSWORD / CREDENTIAL / PRIVATE_KEY / API_KEY / ACCESS_KEY,
database URLs, cloud and provider tokens, SSH agent vars); `REPO_ROOT_PATH` added. Timeouts: setup
20 min, cleanup 5 min. Keep 4 KB of output with control characters removed. Progress goes out as
`daemon.session.setup_step_progress {sessionId, kind, text}`.

**Receipt.** After setup, write a small JSON file into the worktree's **git dir** (not the work tree) with
head SHA, time, lifecycle and a fingerprint list of untracked files. Cleanup uses it to tell setup output
from user work.

### 18.4 Limits

- At most 4 worktree creations at once (2 per repo); 2 removals at once. FIFO queue.
- A worktree just kept by the user is not auto-removed for 30 min.

### 18.5 Removal and auto-delete

Remove (`daemon.cleanup_worktree {worktreePath, deleteLocalBranch?, deleteRemoteBranch?, force?}`):

1. Refuse if the worktree is reserved, in use, or has uncommitted user work (unless `force`).
2. Run the profile's cleanup script (trusted only).
3. Close live sessions; `git worktree remove` (`--force` only when leftovers are setup output);
   `git worktree prune`; remove the empty group folder; forget trust.
4. Mark the sessions removed, broadcast `daemon.worktree.removed`, archive them.

**The branch is kept** unless the caller asks to delete it locally or on the remote.
`daemon.inspect_worktree_deletion` shows what would be lost first (changed files, local-only commits,
PR state).

**Auto-delete** (`worktreeAutoDeleteLimit`, default 15): before each new worktree, if there are more than
the limit of *ephemeral* worktrees, delete least-recently-used ones. Skip pinned and recently used
sessions. Blockers: uncommitted work, local commits not on a remote, an open PR. A merged PR does not
block. One pass at a time.

**Housekeeping:** archiving a session that owns an ephemeral worktree removes it if safe. Every 5 min:
archive sessions whose worktree folder is gone, remove orphaned ephemeral worktrees whose receipt is over
24 h old, `git worktree prune` per repo.

### 18.6 Branch status and git actions

- Watch each checkout's `HEAD` (debounced 150 ms) and broadcast `daemon.worktree.branch_changed`.
- `daemon.list_managed_worktrees`, `list_git_branches`, `checkout_git_branch` (returns
  `needs_resolution` with changed files when the tree is dirty; resolve by stash or commit),
  `get_git_branch_divergence` (ahead/behind), `git_commit {sessionId, message}`, `git_push {sessionId}`.
- Nothing merges back to main automatically. The flow is commit → push → PR, branch kept.
- **Optional (ask Scott):** `create_pr` and PR status (Factory uses the `gh` / `glab` CLIs). Without it,
  the "open PR blocks auto-delete" rule is skipped.

## 19. Notifications, sounds and appearance

Facts are [CLI], [APP] or [WALK] as tagged.

### 19.1 Attention events

The daemon turns session notifications into attention events [CLI]:

- Kinds: `attention_requested`, `attention_resolved` (answered, cancelled, timed out),
  `source_terminated`.
- `requestKind`: `ask_user` (questions and pickers), `permission` (tool approvals), `session_completion`
  (turn finished or failed), `mission_attention` (mission paused, §15.6), `mission_completion`.
- Each event has a short summary and a detail body. Permission summaries name the tool kind (command with
  risk level, edit or create with file name, patch with file count, MCP tool with server, plan approval,
  mission proposal, sandbox block). Completion uses the first meaningful line of the final answer.
  Write your own wording.
- Categories: `questions_and_approvals`, `agent_turn_complete`, `mission_needs_input`, `mission_complete`.
  Factory's workstream categories are a later phase (§15.10).
- If the agent process exits, the daemon sends a `session_process_exited {message, timestamp}`
  notification.

Factory writes these to an outbox and posts them to its backend, which fans out to inbox, email and
desktop push [CLI]. **Your build:** the daemon sends them straight to connected desktop windows (and the
TUI). Email and the inbox are hosted: later phase. [DESIGN]

### 19.2 Desktop notifications

- OS notification per event, tagged per session (so a newer one replaces the older); a click focuses the
  window and opens `/sessions/<id>`. [APP]
- Badge count (`app.setBadgeCount`); clear a session's notifications when it is viewed; report status;
  open the OS notification settings (Windows `ms-settings:notifications`). [APP]
- Settings [WALK]: desktop alerts for "finished" and "needs input" (the two inbox categories). Whether
  Factory skips the toast when the session is already on screen was not checked; [DESIGN] skip it when the
  window is focused on that session.
- TUI: BEL for the `bell` sound; an OSC `9;4` progress sequence exists (when it fires: not checked). [CLI]

### 19.3 Sounds

- **Triggers:** awaiting-input sound when the agent asks a question, shows a picker or requests a
  permission; completion sound on `agent_turn_completed` unless cancelled. [CLI]
- **Settings** (under `general`) [CLI]: `completionSound` (default `off`), `awaitingInputSound` (default
  the built-in "ack" sound), `soundVolume` 0–100 (default 100), `soundFocusMode` (`always | focused |
  unfocused`), `subagentSounds` (`off` default, `quiet` = bell only for nested agents).
- **Values:** `off`, `bell`, two built-in WAVs (Factory names them fx-ok01 and fx-ack01; ship your own
  files), or a custom file path. [CLI]
- **CLI playback:** macOS `afplay`; Linux `paplay`, then `aplay`, then `ffplay`; Windows PowerShell
  `System.Media.SoundPlayer`. When volume < 100 and the player cannot scale, rescale the PCM samples into a
  temp file (≤ 25 MB). Timeout ≥ 5 s. On failure fall back to the bell, only at volume 100. [CLI]
- **Desktop playback:** the main process resolves the file (built-in or a picked custom file) to a data
  URL and the renderer plays it; volume via `audio:getVolume` / `audio:setVolume`. [APP; playback in the
  renderer is CLI-INF]

### 19.4 Appearance (desktop)

- **Theme preference** `system | light | dark`, kept in local storage and applied as a `data-theme`
  attribute by a small script in `index.html` before React loads (no flash). Optional startup background
  colors are stored too (Factory defaults: dark `#161413`, light `#f2f0f0`). The main process sets
  `nativeTheme.themeSource`, the window background and the title-bar overlay colors on change. [APP]
- **Settings page** [WALK]: System / Light / Dark; per-theme presets, import and copy; accent,
  background, foreground and message-bubble colors; contrast; UI, content and code fonts and sizes; diff
  view (unified, wrap, +/- markers); reduce motion. The theme file format was not checked; [DESIGN] a JSON
  file of named color tokens per theme, importable and exportable.
- **Zoom:** per window, saved in `window-zoom.json`. [APP]
- **Fonts:** Factory ships Geist and Geist Mono; choose your own. [APP]
- The TUI keeps the §13.7 cut (light and dark only).

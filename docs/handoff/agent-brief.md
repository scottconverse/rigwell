# Rigwell build brief (shared by every build agent)

Rigwell is a local, model-independent coding agent built from `spec/harness-spec.md` (+ `spec/prompts.md`).
TypeScript on Bun 1.4.4 (`bun`, `node`, `git`, `rg` on PATH). Phase 1 (core loop) is done and green:
`bun test` (104 pass) and `bunx tsc --noEmit -p .` clean. You are building a later phase from spec §9.

## Base branch
Your worktree may start from `main` (spec only). FIRST run `git merge --ff-only phase-1-core-loop` (or `git reset --hard phase-1-core-loop` before any commit) so you build on the current code. Later phases merged into phase-1-core-loop so far: Phase 10 (src/automations), Phase 9 (src/worktree), Phase 2 (src/script, src/jobs), Phase 5 modules (src/hooks, src/mcp, src/skills, src/subagents, src/instructions, src/config; not yet wired into the loop), Phase 5 clients (src/sdk, src/tui, src/daemon/ws.ts), Phase 6 (src/eval), Phases 3+4 (src/agent/request.ts, deferred.ts, cache-monitor.ts, guards.ts, compaction.ts, router.ts; Session.registerDeferredTool exists), Phase 8 (desktop/, src/sidepane), Phase 5 wiring (hooks, MCP, skills, Task/subagents, spec mode, fork_session all live in the loop).

## Code map (Phase 1)
- src/core/types.ts: shared types (Message, ContentBlock, ModelAdapter, StreamEvent, Tool, ToolContext, PermissionDecision...).
- src/protocol/rpc.ts: NDJSON JSON-RPC peer (RpcPeer, RpcError, ErrorCodes, METHOD_PREFIX = "rigwell.").
- src/daemon/connection.ts: one connection = one session; protocol methods -> Session. daemon.ts: Unix-socket daemon.
- src/agent/session.ts: Session class, the agent loop (runTurn, runTools, askPermission), notifications.
- src/agent/prompts.ts: system blocks + context blocks; PROMPT_TEXT in prompt-text.generated.ts is generated from
  spec/prompts.md by scripts/gen-prompts.ts (keys like tool_Script_desc, guard_repeat_nudge, compact_system...).
- src/adapters/: anthropic.ts, openai.ts (Responses API), retry.ts (streamWithRetry), errors.ts, index.ts (createAdapter).
- src/tools/: read, edit, create, execute, grep, glob, registry.ts (createCoreTools, toolsForSession).
- src/permissions/: gate.ts (decide), command.ts (classifyCommand), lists.ts.
- src/storage/: paths.ts (rigwellHome(): $RIGWELL_HOME or ~/.rigwell), transcript.ts, session-settings.ts, settings.ts (loadSettings), models.ts.
- src/cli/main.ts: `rigwell exec` (stream-jsonrpc or one-shot prompt), `rigwell daemon`.
- test/fakes/: startFakeAnthropic / startFakeOpenAI (scripted fake model servers; FakeTurn may be a function of the request body).
- test/e2e/helpers.ts: makeRepo, makeHome, RpcChild (drives `rigwell exec` over stdio).
- docs/decisions.md: numbered decision log.

## Rules (all agents)
1. Build what your phase and the spec sections it points to require. Do not build items on the spec's §1
   "needs Scott's approval" list or the "ask Scott" optional extras. List anything else you think is needed under
   "Proposed additions" in your report instead of building it.
2. No paid model usage, no real API keys, no network to real providers. Test with the local fakes (extend them in
   test/fakes/ if needed).
3. Where the spec is [UNKNOWN] or silent, use its [DESIGN] default; else pick the simplest option and append it to
   docs/decisions.md under a heading "## Phase N: <name>" (numbered entries continuing from the last number).
4. Never copy code or prompt text from Factory's products. `evidence/` holds Factory text: you may read it only to
   check a fact the spec states; never copy its text. Prompt/tool text comes from spec/prompts.md (via PROMPT_TEXT).
   Never use the names "Droid" or "Factory" in code, docs, UI, paths. Paths: `~/.rigwell`, project `.rigwell/`.
5. Tests that run commands or edit files use temp dirs, never the repo. Tests set RIGWELL_HOME to a temp dir.
6. The user forbids the em-dash character (U+2014) anywhere. Do not write it in code, comments, docs or tests.
7. Keep existing tests green. Run `bun test` and `bunx tsc --noEmit -p .` before you finish.
8. Commit your work on your branch with clear messages, ending each commit message with:
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Do not push. Do not include model names anywhere in files.
9. Report only what you ran and saw.

## Report (final message)
Branch name and last commit sha; what you built mapped to the phase scope; the phase's done-when test (exact
command and output); other tests pass/fail; decisions added; files touched outside your own folders (so the lead
can merge); not checked; proposed additions.

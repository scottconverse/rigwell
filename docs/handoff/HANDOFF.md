# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Commit and push only to this branch. Never merge or push main.

## First: set up the session
- Repo: https://github.com/scottconverse/rigwell. The handoff files are on phase-1-core-loop, not main.
- Windows Halo: Bun 1.4.4, Node 22.23.5 (Scoop nodejs22), Git, ripgrep and authenticated gh are installed. Dependencies, Electron and Chromium are installed. Prepend C:/Users/scott/scoop/apps/nodejs22/current to PATH for Node 22.
- Read this file fully, agent-brief.md, PARITY.md and the relevant source specification before the next item. User instructions supersede older workflow rules in agent-brief.md.
- Required checks: bunx tsc --noEmit -p .; cd desktop and npx tsc -p .; bun test; relevant CI in ci.yml and platforms.yml. Native local test windows are forbidden while desktop occupancy is unknown or the owner is using Halo. Use headless affected tests and native CI jobs.
- Never use U+2014 or put model names in added files or commits. Never copy text from evidence/. Tests use fake model/provider servers and local bare remotes only. Log design choices in decisions.md.

## State
- PR feature delivered candidate: 4602ed69beda5e3f503271f2bf2a74f970cf0f6c. ci 43563455830 Linux test/desktop SUCCESS; platforms 43563455849 macOS/Windows tests and unsigned packages SUCCESS. Final affected local headless checks: 215 pass, 0 fail, 785 assertions, 71.47 s (../pr-final-headless.log). Both typechecks pass. No owned local or CI jobs remain. Decisions 330-331 cover implementation and fixtures.
- Workstreams slice 1 delivered: 4bf1e3ff97a527f05a811f001c2df51ac39524b6. ci 43565331507 Linux test/desktop SUCCESS; platforms 43565331388 macOS/Windows tests and unsigned packages SUCCESS. Local 73 affected tests pass, 298 assertions, 26.31 s (../ws-slice1-final.log), both typechecks pass. Decision 332. No owned jobs remain.
- Workstreams slice 2 delivered: 2d7697d8da7d212b8920309a8da90b5ec689f888. ci 43566915232 Linux test/desktop SUCCESS; platforms 43566915169 macOS/Windows tests and unsigned packages SUCCESS. Local affected 123 pass, 0 fail, 551 assertions, 49.33 s (../ws-slice2-final.log); root typecheck pass, desktop inputs unchanged. Decisions 333-334. No owned jobs remain. Old pre-fix sidechat gate shell 17868 and child 64832 were identity-checked, terminated and verified absent.
- Current work: slice 3 listeners and WaitForEvents implemented. Root typecheck and headless affected suite pass: bun test test/workstreams test/agent test/permissions test/sdk test/missions, 130 pass, 0 fail, 587 assertions, 46.46 s (../ws-slice3-affected.log). Seven listener tests cover all event kinds, real tool waits, scopes, recurrence and cancellation. Decision 335. No owned jobs remain. Next push and watch all four required CI jobs before slice 4. Slices 4-6 and remaining PARITY items follow in order. All local work remains headless.
- Group 1 delivered baseline: 026068942212670896129801ad56f0371003becb. ci 43561500066 Linux test/desktop SUCCESS; platforms 43561500068 macOS/Windows tests and unsigned packages SUCCESS. macOS 992 pass, 23 expected platform skips, 0 fail, 87.54 s; Windows suite zero failures, 207.70 s.
- Original Windows worktree root cause: Bun's expect(...).rejects.toThrow stalled subprocess response processing. Await the rejected RPC first and assert its actual in_use response envelope, avoiding false positives from timeout text. bun test test/e2e/worktree.test.ts: 4 pass, 45 assertions, 8.30 s; target setup-profile case 1.75 s. No transport workaround or raised deadline (decision 322).
- Baseline desktop fixes: native visibility fallback on did-finish-load; discard stale overlapping sidebar refreshes; acknowledge side-chat write toggles; portable fixtures and Windows shell Enter handling. macOS native stack proved cookie-key creation waited in SecItemAdd/defaultKeychainUI/AuthorizationCopyRights. Unsigned UI tests now use Chromium's mock Keychain, with shutdown assertions active. The unproven deferred-exit hypothesis was reverted (decisions 325-329).
- Owner-authorized CodexElevatedDevHelper job c30ef34e03594787b19f3649dfcfa851 enabled Developer Mode, exit 0. Prior registry state: ../developer-mode-before.json. File-symlink tests then passed 8 tests/32 assertions. Full local Windows baseline: 989 pass, 25 expected platform skips, 0 fail, 5401 assertions, 259.34 s (../full-devmode.log). All symlink assertions remain active.
- Remaining order: Workstreams six green slices, then every remaining PARITY item in order. All are approved. Owner-provided keys/OAuth IDs/Stax/signing inputs are needed when those acceptance items are reached. Do not stop while independent authorized work remains.

## Completed: `create_pr` (owner approved, green on 4602ed6)
Spec §18.6 (and §18.5 for the auto-delete rule). Scope:
- Daemon method `rigwell.create_pr {worktreePath, title?, body?, base?, draft?}`: push the session's worktree branch
  (`git push -u origin <branch>`), then open the PR with the `gh` CLI if present (`gh pr create`), else the GitHub REST API
  with a token from the credential store (`src/storage/credentials.ts`, name e.g. `github`). Return `{url, number}`.
- Always confirm first: a `request_permission` with confirmationType `create_pr` showing branch, base, title and body;
  nothing is pushed on cancel. Headless runs without an approver refuse.
- `rigwell.get_pr_status {worktreePath}`: open/merged/closed and checks summary (via `gh pr view --json` or the API).
- Auto-delete (§18.5) skips a worktree whose branch has an open PR (the rule decision #254 skipped).
- UI: a "Create PR" button and PR status chip in the desktop worktree panel (`desktop/`), and `/pr` in the TUI.
- Tests with a local bare repo as origin and a fake `gh` script / fake API server; never call real GitHub.

## Next task: build local Workstreams (owner approved; the main reason for Rigwell)
Spec §15.10 has the full design: a lead session spawns long-lived member agents (own worktrees), messages them,
waits on listeners, interrupts and archives them, through `ProposeWorkstream`, `SpawnAgent`, `ListAgents`,
`SendMessage`, `InterruptAgent`, `RenameAgent`, `ArchiveAgent`, `CreateListener` and `WaitForEvents`. Shared state
lives in `$RIGWELL_HOME/workstreams/<id>/`. Member permission prompts go to the user, never the lead. Desktop
Workstreams page, TUI `/workstreams` and `/ws`, protocol methods and notifications as in §15.10.5 and 15.10.6.
Reuse the daemon's multi-session support, `src/worktree/`, `src/missions/` (folder, watchdog) and `src/subagents/`.
Tests per §15.10.8, fake model servers only. Decision 319 records the approval. Build it in slices, each green:
(1) shared folder, roster and spawn; (2) messaging and delivery priorities; (3) listeners and `WaitForEvents`;
(4) interrupt, rename, archive, budget, concurrency cap, restart recovery; (5) protocol and desktop page; (6) TUI.

## Full parity: everything is approved
The owner approved EVERY remaining item (Nov 14 2026): all hosted features as local versions, the PR review view,
plugins and marketplace, GitHub/Slack/CI/chained triggers (previously declined, now approved), Slack and Teams
delegation, remote machines, sync, phone access, wiki, academy, analytics, evaluations, policy, spend limits,
profiles and release work. Spec §20 has the design; `docs/handoff/PARITY.md` is the build order (43 items).
Build all of it; leave nothing out. Decision 320 records the approval.

## Current acceptance work
- Group 1 is complete on 0260689: Windows worktree, Linux native visibility, sidebar refresh race, macOS Keychain test isolation, and all four CI jobs green. See State and decisions 322-329.
- create_pr is delivered on 4602ed6 with all four CI jobs green. Workstreams slice 1 is current.

## Waiting on the owner (do not decide for them)
- (Resolved) `create_pr` and PR status (§18.6): the owner APPROVED building it. See "Next task" below.
- License: decided by the owner: AGPL-3.0-only (`LICENSE`, package.json `license`, README, NOTICE).
- (Resolved) Workstreams (§15.10): the owner APPROVED a local build. See "Next task 2".
- (Resolved) Everything else: APPROVED (spec §20, PARITY.md). Nothing is declined any more.
- The owner must supply, when you reach them: Rigwell's own OAuth client IDs (§20.2), API keys for real-model
  runs (§20.1), signing certificates (§20.24), a real Google Stax export file (§20.19). Ask; do not invent them.

## Not verified on real hardware
macOS and Windows beyond CI, real OS keychains, real clipboards and terminals, signed and notarized installers, and the
electron-updater install path.

## Working rules used so far
`docs/handoff/agent-brief.md` holds the rules every build agent followed: no Factory or Droid names, no copying text from
`evidence/`, no em-dash characters (U+2014), tests in temp dirs, fake model servers only, decisions logged, and the
commit trailer. The CI `test` job allows unprivileged user namespaces for the bubblewrap tests; the owner approved this.

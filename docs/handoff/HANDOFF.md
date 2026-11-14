# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Do not merge without the owner.

## First: set up the session
- Repo: `https://github.com/scottconverse/rigwell`. Work on branch `phase-1-core-loop` (this file does not exist on `main`):
  `git clone https://github.com/scottconverse/rigwell && cd rigwell && git checkout phase-1-core-loop`.
  Commit and push to `phase-1-core-loop`; it feeds draft PR #1. Never push to `main`.
- Tools: bun 1.4.4, node 22, git, ripgrep (`rg`). For the sandbox tests on Linux: `bubblewrap` and `socat`.
  For the desktop tests: Xvfb (`xvfb-run`), then `cd desktop && npm install` and, if `desktop/node_modules/electron/dist`
  is missing, `node node_modules/electron/install.js`. Packaging tests need `cd desktop && bun run package:linux` first.
- Install and check: `bun install`, `bunx tsc --noEmit -p .`, `cd desktop && npx tsc -p .`, `xvfb-run -a bun test`, `bun perf/gate.ts`.
- CI logs: `gh run list --branch phase-1-core-loop`, then `gh run view <run-id> --log-failed` (or `gh run view --job <job-id> --log`).
  Workflows: `.github/workflows/ci.yml` (Linux `test`, `desktop`) and `.github/workflows/platforms.yml` (macOS, Windows).
- Owner preferences: never use the em-dash character (U+2014) anywhere. No model names in commits or files.
  Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>` (or your session's attribution line).

## State
- Windows takeover, 2026-11-13, baseline worktree fix 987098e (pushed, based on bd94639): the worktree failure is fixed in the test. Bun 1.4.4 on Windows stalls subprocess response handling when the pending RPC rejection is passed directly to expect(...).rejects.toThrow. Await the RPC rejection first, then assert its message and the actual in_use response envelope. With all product code and temporary traces restored, bun test test/e2e/worktree.test.ts passes 4 tests / 45 assertions in 8.30 s; the setup-profile case takes 1.75 s. Earlier instrumented 21 s passes were false positives because the timeout diagnostic contained the expected error text. They are invalid evidence.
- Windows desktop acceptance: bun test test/desktop passes 167 tests, 5 expected Linux-package skips, 755 assertions in 55.71 s. Electron now runs natively on Windows. Fixed composer readiness, portable dictation/side-chat fixtures, Windows cookie-import refusal acceptance, and real terminal Enter handling (CRLF plus flush for the Windows pipe shell). The side-chat writes switch now disables while saving, with an explicit test wait for the acknowledged state; affected rerun passed (12 tests, 43 assertions, 9.20 s, including all final-gap UI and linked-root cases).
- Current pushed candidate: caa2f02c29e4d267bb85b8298bf3fb95ec738e85. CI 43559909879: Linux test and desktop passed. Platforms 43559909877: Windows tests and unsigned package passed. macOS was cancelled after capturing the shutdown stall; its logs prove both services stopped and app.exit was reached but the native process stayed alive. Runs started about 2026-11-14 05:06 UTC. Expected terminal result: Linux test/desktop and Windows/macOS tests plus packages green. Decision 328 defers final exit outside the cleanup promise continuation and samples the native stack if still stuck. Affected native Electron checks finished: 18 tests passed, 0 failed, 55 assertions in 26.90 s (../deferred-exit.log). Both typechecks pass. No owned local jobs remain. Next push decision 328 and inspect macOS CI. Next inspect macOS CI for the next candidate; cancel only if superseded via gh run cancel. Prior 4b8ab5e had both Linux jobs green, Windows failed only on a promoted sidebar row, macOS hung on Electron close. Decisions 326-327 simplify the folder-trust fixture, install Chromium, diagnose shutdown and reproduce/fix stale sidebar publication. Superseded platform runs 43558834368 and 43559136162 are cancelled and logs saved outside the repo. No owned local jobs remain. Continue baseline fixes, then create_pr, Workstreams slices, then all remaining PARITY items in order.
- Tools: Bun 1.4.4, Node 22.23.5 (user-level Scoop nodejs22), Git, ripgrep and authenticated gh are available. Dependencies and Electron installed. For this shell prepend C:/Users/scott/scoop/apps/nodejs22/current to PATH. Full Windows suite finished: 988 pass, 25 expected platform skips, 1 fail (file-symlink creation EPERM), 5396 assertions, 255.08 s; log ../full-candidate.log. Both root and desktop typechecks passed. Final affected Electron/link rerun passed 12 tests / 43 assertions in 9.20 s; log ../last-affected.log. After the owner directed use of CodexElevatedDevHelper, helper job c30ef34e03594787b19f3649dfcfa851 enabled Developer Mode (AllowDevelopmentWithoutDevLicense=1), exit 0. Previous registry state saved outside the repo at ../developer-mode-before.json. Normal-session instruction symlink tests now pass 8 tests / 32 assertions. Full Windows rerun passed 989 tests, 25 expected platform skips, 0 failures, 5401 assertions in 259.34 s (../full-devmode.log). This covers 4b8ab5e; subsequent diagnostics and sidebar-version changes need affected checks. Final affected rerun passed 19 tests / 56 assertions in 26.60 s (../shutdown-affected-fixed.log), including the reproduced stale-refresh regression, native promotion/archive, theme relaunch and shutdown helper. Both typechecks pass. No owned local jobs remain. Next push the decisions 326-327 candidate and inspect all CI jobs, especially macOS shutdown diagnostics.
- Historical baseline before the approved section 20 expansion: all 11 phases in §9, two audit gap waves, and the owner-approved §1 items
  (voice dictation, built-in skills, API keys/secrets/environments pages, automation templates, VISUAL.html, guided setup,
  tray icon, Chrome cookie import), plus OAuth sign-in (`credentialSource`, no shipped client IDs).
- Choices where the spec was silent: `docs/decisions.md` (numbered; superseded entries are marked, not deleted).
- Historical local Linux baseline: `bun test` 1011 pass / 0 fail (run `cd desktop && npm install`, and `node node_modules/electron/install.js`
  if `node_modules/electron/dist` is missing, before the desktop tests; build the Linux package with
  `cd desktop && bun run package:linux` for the packaging tests). `bunx tsc --noEmit -p .` and `cd desktop && npx tsc -p .` clean.
- Historical CI baseline had Linux test and macOS package green; the current candidate requires fresh CI as recorded above.

## Next task: build `create_pr` (owner approved)
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

## Next task 2: build local Workstreams (owner approved; the main reason for Rigwell)
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
- Worktree target is locally fixed (decision 322). Upstream trust and ask-user failures have passed on bd94639. Linux desktop on 987098e failed the first Dictate click: diagnostics prove the native window remained hidden although the page was loaded. Decision 325 adds an idempotent initial show on did-finish-load as well as ready-to-show; startup visibility, theme and tray affected checks passed locally: 20 tests / 56 assertions in 31.84 s (../startup-current.log); desktop typecheck passed. No local test jobs remain. Next commit/push decision 325 and verify CI. No timeout increase or forced click.
- macos-14 was retired on November 2, 2026; upstream job annotation says its configuration is unsupported. Matrix now uses macos-15; CI verification pending.
- Full Windows suite exposed personal-skill contamination, POSIX-only test commands and two product shell assumptions. Tests now isolate personal home; graders and custom status lines use the platform shell. Status-line timeouts terminate the process tree. Affected checks passed, including all 43 TUI gap tests.
- File-symlink privilege blocker resolved through the owner-authorized elevated helper. All symlink assertions remain active. Full Windows rerun passed; see State.

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

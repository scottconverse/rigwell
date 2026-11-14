# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Commit and push only to this branch. Never merge or push main.

## First: set up the session
- Repo: https://github.com/scottconverse/rigwell. The handoff files are on phase-1-core-loop, not main.
- Windows Halo: Bun 1.4.4, Node 22.23.5 (Scoop nodejs22), Git, ripgrep and authenticated gh are installed. Dependencies, Electron and Chromium are installed. Prepend C:/Users/scott/scoop/apps/nodejs22/current to PATH for Node 22.
- Read this file fully, agent-brief.md, PARITY.md and the relevant source specification before the next item. User instructions supersede older workflow rules in agent-brief.md.
- Required checks: bunx tsc --noEmit -p .; cd desktop and npx tsc -p .; bun test; relevant CI in ci.yml and platforms.yml. Native local test windows are forbidden while desktop occupancy is unknown or the owner is using Halo. Use headless affected tests and native CI jobs.
- Never use U+2014 or put model names in added files or commits. Never copy text from evidence/. Tests use fake model/provider servers and local bare remotes only. Log design choices in decisions.md.

## State
- Latest delivered candidate: b0bb97990837a10b65a40197cc10663151346629, PARITY item 7 (code-provider connections). ci 43579114100 Linux test/desktop SUCCESS; platforms 43579114034 macOS/Windows tests and unsigned packages SUCCESS. Both typechecks pass. Local affected evidence: 68 pass/369 assertions, 18.79 s (../code-providers-cli-final.log); isolated PR tests 13 pass/70 assertions, 12.09 s. Decisions 355-356.
- Delivered earlier: original Windows worktree and native CI fixes on 0260689 (decisions 322-329); create_pr on 4602ed6 (330-331); Workstreams six individually green slices on 4bf1e3f, 2d7697d, cb301f2, 5a49b8a, fb25ae0, c6c6b64 (332-354). Last Workstreams runs ci 43577486701 and platforms 43577486738 all green. The intermittent macOS restart file-listener cause remains unresolved and instrumented, not claimed fixed.
- Original Windows worktree failure was Bun expect(...).rejects.toThrow stalling subprocess response processing. Await the actual rejected RPC before checking its in_use envelope. Reproduction after fix: 4 pass/45 assertions, 8.30 s, target setup case 1.75 s. No transport workaround or raised deadline. Owner-authorized elevated helper enabled Developer Mode, exit 0; real symlink tests passed. Full local Windows baseline before headless-only instruction: 989 pass/25 expected platform skips/0 fail, 5401 assertions, 259.34 s (../full-devmode.log).
- Current item 8 (Review, spec 20.10) is implemented locally and uncommitted. Decisions 357-359. Full page, real protocol, provider APIs/CLI, semantic parsing and /review exist. Root and desktop typechecks and headless desktop build pass. Broad affected run: 252 pass/3 fail, 1109 assertions, 38.70 s (../review-affected.log); all Review tests passed. Failures were custom-command fixture collision with the newly reserved /review. After fixture correction, all 43 gap tests pass/134 assertions, 1.01 s (../review-tui-fixture-final.log). Added paginated-check completeness acceptance passes (../review-host-pagination.log). No active owned local or CI jobs.
- Item 8 candidate 0e51a3b80356ea40ba8aa5013b9e5d236620df49 pushed at 2026-11-14 09:48 UTC. Owned remote runs: ci 43582247295 and platforms 43582247282, expected terminal result all four jobs and packages successful; next action gh run view each run, inspect failed logs, cancel only these owned runs if explicitly stopped. Both final typechecks and headless build pass. No local background job. Free RAM before remote delivery about 28.8 GiB.
- Item 8 CI: Linux test SUCCESS, Linux desktop FAILED (175 pass/5 expected skips/1 fail), native file save showed Saved but original text remained. Failure log ../review-ci-failed.log. macOS tests/package SUCCESS; Windows still running as of 09:53 UTC. Decision 360. A new headless production editor acceptance passes 1 test/22 assertions, 1.99 s; native failure-only state/input diagnostics added locally. Root cause remains unresolved. No editor behavior or timeout changed. Root typecheck passes.
- Next action: finish watching Windows, push the diagnostic candidate and inspect all four jobs before item 9. Halo stays headless. Native Electron only in remote CI. Free RAM before item 8 was about 28 GiB.
- Owner inputs: public registered GitHub/GitLab OAuth client IDs requested and pending. Real device sign-in unverified. Quality runs later need real provider keys through the credential store; release signing must use the owner's established signing workflow. Build independent authorized work around missing inputs. No real-provider or real-code-host review writes were tested.
- Remaining scope: every remaining PARITY item in order, including local versions of hosted features, all owner approved. Do not add beyond the specification. After each item, deliver and watch Linux test/desktop and macOS/Windows jobs including packaging before advancing. Update this state record on candidate changes, jobs, blockers and handoff.

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
- create_pr is delivered on 4602ed6; Workstreams through slice 6 delivered on c6c6b64, all four CI jobs green (see State). Current item is code-provider connections (20.21).

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

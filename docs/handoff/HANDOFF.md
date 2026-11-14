# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Commit and push only to this branch. Never merge or push main.

## First: set up the session
- Repo: https://github.com/scottconverse/rigwell. The handoff files are on phase-1-core-loop, not main.
- Windows Halo: Bun 1.4.4, Node 22.23.5 (Scoop nodejs22), Git, ripgrep and authenticated gh are installed. Dependencies, Electron and Chromium are installed. Prepend C:/Users/scott/scoop/apps/nodejs22/current to PATH for Node 22.
- Read this file fully, agent-brief.md, PARITY.md and the relevant source specification before the next item. User instructions supersede older workflow rules in agent-brief.md.
- Required checks: bunx tsc --noEmit -p .; cd desktop and npx tsc -p .; bun test; relevant CI in ci.yml and platforms.yml. Native local test windows are forbidden while desktop occupancy is unknown or the owner is using Halo. Use headless affected tests and native CI jobs.
- Never use U+2014 or put model names in added files or commits. Never copy text from evidence/. Tests use fake model/provider servers and local bare remotes only. Log design choices in decisions.md.

## State
- Prior delivered candidate c2a7847e5643219ec9945789856e37f01beff2c5: Review, PARITY item 8. ci 43582766140 Linux test/desktop SUCCESS; platforms 43582766160 macOS/Windows tests and unsigned packages SUCCESS. Both typechecks and headless desktop build pass. Local Review affected run 252 pass/3 custom-command fixture failures (../review-affected.log); corrected fixture 43 pass/134 assertions; provider pagination 7 pass/138 assertions; production file editor headless acceptance 1 pass/22 assertions. Decisions 357-360. No owned active local/CI jobs.
- Previous 0e51a3b had Linux native file-save failure: UI Saved while original text remained (../review-ci-failed.log). Unresolved root cause, failure-only input/DOM/React diagnostics retained. No editor behavior/deadline changed. c2a7847 green does not prove that defect fixed. Intermittent macOS Workstreams restart file-listener cause also remains unresolved and instrumented (354).
- Delivered earlier: original Windows worktree and native CI fixes 0260689 (322-329), create_pr 4602ed6 (330-331), six individually green Workstreams slices through c6c6b64 (332-354), code-provider connections b0bb979 (355-356). Each delivered candidate had all four CI jobs/packages green.
- Windows worktree root cause was Bun expect(...).rejects.toThrow stalling subprocess processing. Await actual rejected RPC then assert in_use envelope: 4 pass/45 assertions, 8.30 s; setup case 1.75 s. No transport workaround or raised deadline. Authorized elevated helper enabled Developer Mode; real symlink tests pass. Historical full local Windows baseline before headless-only instruction: 989 pass/25 expected skips/0 fail, 5401 assertions, 259.34 s (../full-devmode.log).
- Item 9 real adapter smoke awaits requested owner-configured profiles/credentials. Presence-only preflight found no configured Rigwell models and known provider credential environment variables unset. No secrets printed or real requests made. Public registered GitHub/GitLab OAuth client IDs also requested/pending; real device sign-in unverified.
- Independent item 10 task suite candidate f32bc06cde98f51a9d94f16605151c8bec2b9a2e pushed 2026-11-14 10:21:08 UTC: 43 tasks in eval/tasks, all six categories, actual grader control/reference validation and fake CLI category acceptance. Decisions 361-362. Eval checks 54 pass/261 assertions, 18.61 s (../quality-eval-affected.log); six real-CLI/fake-provider integration cases pass (../task-cli-validation.log). Final root typecheck passes after CLI integration. No active local jobs. ci 43584866285 Linux test/desktop SUCCESS; platforms 43584866255 macOS/Windows tests/packages SUCCESS. Latest delivered candidate f32bc06. No owned active jobs.
- Owner steering: use existing Windows-stored keys and inspect TownReporter AI setup. Read current TownReporter source and read-only AI connection metadata: native signed-in coding CLIs, one saved encrypted Google API connection, local Ollama endpoint. No raw secrets displayed or transferred. Windows credential target inventory inspected; API environment/user/machine fields absent. LM Studio and Ollama reachable, no chat model loaded; about 28.8 GiB free RAM. No local defaults or TownReporter files/database changed. Asked whether no-model-names rule permits IDs in private runtime settings/session records; answer pending. Rigwell direct API/local transports exist, subscription sign-in is a separate approved item and not yet accepted.
- Next action: real smoke using retrieved relevant keys once runtime-profile rule is clarified; continue independent head-to-head machinery meanwhile. Installed comparison CLI located under the desktop package; --version reports 1.10.1 and exec --help verified headlessly. Real comparison remains unverified. Halo headless only. Free RAM before validation about 28.8 GiB. Do not run native Electron locally.
- Item 11 comparison machinery is local/uncommitted. Decision 363. Broad eval regression: 63 pass/301 assertions, 27.56 s (../comparison-affected.log). After installed-help evidence, initialize_session carries explicit autonomy and effort; comparison plus existing eval loop pass 5 tests/79 assertions, 8.43 s (../comparison-wire-validation.log). Final root typecheck and comparison runtime-settings acceptance pass (../comparison-runtime-settings.log). No active jobs. Next: final checks, commit/push, watch all four CI jobs. Real comparisons and every-adapter smoke are not claimed complete.
- Remaining scope: every remaining PARITY item in order, all owner approved, local versions of hosted features. Build independent authorized work around missing owner inputs. Later inputs include real comparison account, OAuth IDs, Stax export and established signing workflow. No additions beyond spec. Never main/merge; never real keys in tests/CI.

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
- create_pr is delivered on 4602ed6; Workstreams through slice 6 delivered on c6c6b64, all four CI jobs green (see State). Code-provider connections delivered on b0bb979; Review delivered on c2a7847. Current item is the quality task suite (20.1), while real adapter smoke waits for owner profiles.

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

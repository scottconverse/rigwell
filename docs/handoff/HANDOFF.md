# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Commit and push only to this branch. Never merge or push main.

## First: set up the session
- Repo: https://github.com/scottconverse/rigwell. The handoff files are on phase-1-core-loop, not main.
- Windows Halo: Bun 1.4.4, Node 22.23.5 (Scoop nodejs22), Git, ripgrep and authenticated gh are installed. Dependencies, Electron and Chromium are installed. Prepend C:/Users/scott/scoop/apps/nodejs22/current to PATH for Node 22.
- Read this file fully, agent-brief.md, PARITY.md and the relevant source specification before the next item. User instructions supersede older workflow rules in agent-brief.md.
- Required checks: bunx tsc --noEmit -p .; cd desktop and npx tsc -p .; bun test; relevant CI in ci.yml and platforms.yml. Native local test windows are forbidden while desktop occupancy is unknown or the owner is using Halo. Use headless affected tests and native CI jobs.
- Never use U+2014 or put model names in added files or commits. Never copy text from evidence/. Tests use fake model/provider servers and local bare remotes only. Log design choices in decisions.md.

## State
- Current item 18 bca0844464dcd56d86e9643843bf5633bfa68a58: Linux ci 43599075345 both jobs green; platforms 43599075422 macOS tests/package green, Windows fails first two new browser cases at unchanged 15-second deadlines. Cancellation/profile cleanup and both policy cases pass. Failure log ../browser-windows-current-failed.log. Root not established: Page.navigate still pending when test runner kills browser. Halo five-case repro passes/34 assertions, 4.25 s. Uncommitted diagnostics (385) add opt-in method/event trace and eight-second failure breadcrumbs; local five cases and root types pass. No local or CI jobs active. Next: commit/push diagnostics, watch exact candidate all four jobs/packages, use the trace to fix Windows stalls before item 19. Headless only on Halo. Browser implementation decisions 378-384, docs/browser.md; final affected budget/browser/proxy/skill 19 pass/323 assertions, protocol/Script/worktree 32 pass/464 assertions. Item 19 read-only preparation traced daemon, automation/mission and persistent Workstream member execution paths; no SSH implementation yet.
- Item 18 CI history: f9348f6 Linux test/perf/native desktop green; macOS headless navigation/exit stalls fixed by disposable-profile native password-store flags (382). Windows old log has 4 new browser passes and retained profile on cancellation; bounded asynchronous filesystem retries added (383). 27dd735 Linux green; macOS passes 4 new cases and fails text replacement only, now uses explicit selectAll editing command (384). Superseded platform runs 43597990194 and 43598583465 terminal canceled after reading macOS failures. Superseded bd8885f Linux ci 43598781876 green; platforms 43598781885 terminal canceled. Logs ../browser-macos-job.log, ../browser-macos-keychain.log, ../browser-windows-superseded.log. No final Windows or macOS result established yet.
- Item 17 delivered on 342ce8c7f27b79f2501d9d1c7c438ead9535d244: ci 43594379090 Linux test/desktop SUCCESS; platforms 43594379025 macOS/Windows tests and unsigned packages SUCCESS. Catalog decisions 376-377, docs/connectors.md; affected 84 pass/438 assertions, 10.09 s, both typechecks/headless build pass.
- Item 16 delivered on 2c8d082: ci 43592910074 Linux test/desktop SUCCESS; platforms 43592910098 macOS/Windows tests and unsigned packages SUCCESS. MCP OAuth (369-372), Workstream missed-notification reconciliation (374), canonical deletion assertions (375). Affected MCP 80 pass/406 assertions; Workstreams 38 pass/236 assertions, final assertion correction 9 pass/43 assertions. Earlier 50b2301 failed only expected deletion path aliases on both platforms. No owned active CI jobs.
- Item 15 delivered on 056f0242e0cf7205b23fbcbb62c61d86283c21e8: ci 43589149870 Linux test/desktop SUCCESS; platforms 43589149921 macOS/Windows tests/packages SUCCESS. Decisions 365-368. Guided account setup, five provider forms, preserved adapter options, account references, Google OAuth and masked client/cloud secrets. Final affected 64 pass/362 assertions, 6.32 s (../subscription-affected-final.log); both typechecks/headless build passed. Registered real-client IDs remain pending. No owned active CI jobs.
- Latest delivered candidate 680bdd2c0337e6671ff03f80ead956add51b6ac2: local clarification record (364), docs/spec-clarifications.md covers historical unknown behavior choices without claiming external observations. ci 43587503989 Linux test/desktop SUCCESS; platforms 43587503928 macOS/Windows tests/packages SUCCESS. No owned active CI jobs. Performance and real hardware acceptance remain separately required.
- Comparison machinery delivered on 52f145bb1394c125e1b4406885a3fbe154764bff (363): ci 43586770586 and platforms 43586770626 all four jobs/packages SUCCESS. 63 eval tests/301 assertions before final wire correction; final comparison/loop 5 pass/79 assertions plus private-settings acceptance 3 pass/23 assertions. Verifies installed external CLI version, equivalent-profile mapping, exactly three fresh trials and explicit wire autonomy/effort. Real comparison unmeasured.
- Task suite delivered on f32bc06cde98f51a9d94f16605151c8bec2b9a2e (361-362): 43 graded tasks across six categories; 44 failing/passing grader controls pass, six real-CLI/fake-provider category trials pass. ci 43584866285 and platforms 43584866255 all four jobs/packages SUCCESS. No real-agent quality score is inferred from these checks.
- Earlier delivered: Windows/native CI fixes 0260689 (322-329), create_pr 4602ed6 (330-331), six individually green Workstreams slices through c6c6b64 (332-354), code-provider connections b0bb979 (355-356), Review c2a7847 (357-360). All four jobs/packages green for each delivered item. Windows worktree root cause was Bun expect(...).rejects.toThrow stalling subprocess progress; await rejection before checking the RPC envelope. Local 4 pass/45 assertions, 8.30 s; setup case 1.75 s. No deadline increase. Authorized elevated helper enabled Developer Mode. Historical full Windows baseline before headless-only rule: 989 pass/25 expected skips/0 fail, 5401 assertions, 259.34 s (../full-devmode.log).
- Unresolved intermittent defects: Windows mission-recovery default deadline (373) and native Linux file-save displayed Saved while disk retained old text (360). Failure diagnostics are retained. Subsequent green jobs do not establish either cause. Local production file-editor headless check passed ten actual writes plus stale-write guard, 1 test/22 assertions. Inspect diagnostics on recurrence before changing behavior.
- Real-input work: items 9, 11, 12 and 14 still need actual quality runs. Owner says use existing Windows-stored keys and inspect TownReporter. Read TownReporter source at C:/Users/scott/Desktop/Code/townreporter-web and read-only connection metadata. It has signed-in coding-CLI bridges, one encrypted Google API connection and local endpoints. Retrieved that Google key only in process memory: read-only provider catalog HTTP 200 and saved model present (../preflight-town-key.cjs). No raw key/model ID printed or written by the probe; no inference or CLI coding-task smoke yet. No TownReporter files/database/defaults changed. Windows credential targets and environment presence inspected; no direct Anthropic/OpenAI/Bedrock API credentials found. Coding-client subscription tokens are not independent API keys.
- Local preflight: Ollama 11434 and LM Studio 1234 reachable; several small downloaded tool-capable real local candidates; no chat model loaded. About 28.8 GiB RAM free at preflight. Installed reference CLI under the desktop package is version 1.10.1; help verified headlessly. Real comparison account validity not checked. Owner clarification pending: whether the no-model-names rule permits IDs in private runtime settings/session records. Do not write actual IDs pending that answer. Registered Rigwell OAuth client IDs are also pending; API keys do not supply public app registrations. Real device/subscription sign-in is not verified.
- Scope remains every item in PARITY/spec 20, in order where executable, all owner approved. Missing later inputs include Stax export and the established signing workflow. Real keys only in hand-run quality work; tests/CI fake services only. Halo headless only; no native Electron windows locally. Commit/push only phase-1-core-loop, never main or merge. No subagents, goals or automation. Maintain this one State record with candidate/job ownership and next action.

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
- create_pr is delivered on 4602ed6; Workstreams through slice 6 delivered on c6c6b64, all four CI jobs green (see State). Code-provider connections delivered on b0bb979; Review delivered on c2a7847. Task suite, comparison machinery and specification clarifications are delivered; current independent item is browser automation. Real adapter smoke/comparisons/long sessions remain pending runtime-profile clarification and credentials for remaining adapters.

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

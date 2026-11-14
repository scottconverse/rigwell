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
- The whole spec (`spec/harness-spec.md`) is built: all 11 phases in §9, two audit gap waves, and the owner-approved §1 items
  (voice dictation, built-in skills, API keys/secrets/environments pages, automation templates, VISUAL.html, guided setup,
  tray icon, Chrome cookie import), plus OAuth sign-in (`credentialSource`, no shipped client IDs).
- Choices where the spec was silent: `docs/decisions.md` (numbered; superseded entries are marked, not deleted).
- Local Linux: `bun test` 1011 pass / 0 fail (run `cd desktop && npm install`, and `node node_modules/electron/install.js`
  if `node_modules/electron/dist` is missing, before the desktop tests; build the Linux package with
  `cd desktop && bun run package:linux` for the packaging tests). `bunx tsc --noEmit -p .` and `cd desktop && npx tsc -p .` clean.
- CI (`.github/workflows/ci.yml`, `.github/workflows/platforms.yml`): Linux `test` green; macOS tests + app package green.

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

## Also note
The `desktop` CI job still failed on a0f7175 even with the trust-dialog fallback (decision 318): read that run's
`electron-handlers` diagnostic block first.

## Open issues (start here)
1. **Windows, 1 test:** `test/e2e/worktree.test.ts` "a setup profile runs with secrets stripped; REPO_ROOT_PATH set;
   protocol list/status/remove" hangs ~21 s on a protocol call (RpcChild waits 20 s per call). Two fix attempts are in
   (decisions "Platform fixes: Windows", entries 316 and 317). Latest failing job: Actions job 125070575048 (head dc52906).
   RpcChild now captures child stderr live, so that log should name the stuck step: read the error above its "(fail)".
   Suspects: a git subprocess waiting for input on Windows, a PowerShell setup/cleanup script that never exits, a grandchild
   holding the stdout pipe, a file lock blocking `git worktree remove`.
2. **Linux CI `desktop` job, 2 tests:** `test/desktop/electron-handlers.test.ts` (trust dialog; ask-user panel) fail only on
   the GitHub runner: the composer keeps the typed text after Enter, 0 model requests, no `request_trust`. They pass locally,
   also as a non-root user with a fresh HOME and CI=true. The latest commit (decision 318) verifies the send, falls back to
   clicking Send, and logs every keydown, focus and data-ready. Read the next run's diagnostic block to see whether Enter
   reaches the editor. Never skip these tests and never only raise timeouts.
3. Occasional flake seen once locally under load: `test/desktop/electron-final.test.ts` "side chat: the writes switch" and
   "Archive Project". Not investigated.

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

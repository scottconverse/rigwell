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

## Done in the last session (Windows PC)
- Windows worktree e2e hang: fixed (decision 319, commit 1aba96a). Root cause was the test's `expect(c.call(...)).rejects` wait on Windows.
- Linux CI `desktop` job: fixed (decision 320, commit 7974e45). The window was never shown under Xvfb. All CI jobs green on 7974e45.
- `create_pr` and `get_pr_status` (spec 18.6) built: `src/worktree/pr.ts`, daemon methods in `src/worktree/connect.ts`,
  auto-delete skips open PRs, desktop "Create PR" button and chip, TUI `/pr`. Decisions 321 to 327.
  Tests: `test/worktree/pr.test.ts`, `test/e2e/create-pr.test.ts`, `test/tui/pr-ui.test.ts` (fake gh and fake API only).

## Next task
None assigned. Ask the owner. The spec is built; later phases (hosted parts, Workstreams, MCP OAuth) need the owner's go-ahead.

## Open issues
1. Occasional flake seen once locally under load: `test/desktop/electron-final.test.ts` "side chat: the writes switch" and
   "Archive Project". Not investigated.
2. On a Windows PC without the symlink right, tests that create symlinks fail with `EPERM` (decision 319). CI has the right.

## Waiting on the owner (do not decide for them)
- (Resolved) `create_pr` and PR status (§18.6): approved and built (decisions 321 to 327).
- License: decided by the owner: AGPL-3.0-only (`LICENSE`, package.json `license`, README, NOTICE).
- Declined by the owner: GitHub-event and Slack-message triggers. Spec later phases (not built): hosted parts, §15.10 Workstreams, MCP OAuth.

## Not verified on real hardware
macOS and Windows beyond CI, real OS keychains, real clipboards and terminals, signed and notarized installers, and the
electron-updater install path.

## Working rules used so far
`docs/handoff/agent-brief.md` holds the rules every build agent followed: no Factory or Droid names, no copying text from
`evidence/`, no em-dash characters (U+2014), tests in temp dirs, fake model servers only, decisions logged, and the
commit trailer. The CI `test` job allows unprivileged user namespaces for the bubblewrap tests; the owner approved this.

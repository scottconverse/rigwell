# Handoff: Rigwell build state

Branch `phase-1-core-loop`, draft PR scottconverse/rigwell#1 (base `main`). Do not merge without the owner.
The repo is public (Nov 2 2026, decision 337). `evidence/` is not in it; it is in the private repo `scottconverse/rigwell-private`,
with the old history and the old PR #1. Commit IDs in this file are from that old history.

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
- Release targets (decision 341): Windows is the only platform a release needs. macOS and Linux ship when they build,
  and never block or delay a release. `.github/workflows/release.yml` builds the installers for a `v*` tag.

## Done in the last session (Windows PC)
- Windows worktree e2e hang: fixed (decision 319, commit 1aba96a). Root cause was the test's `expect(c.call(...)).rejects` wait on Windows.
- Linux CI `desktop` job: fixed (decision 320, commit 7974e45). The window was never shown under Xvfb. All CI jobs green on 7974e45.
- `create_pr` and `get_pr_status` (spec 18.6) built: `src/worktree/pr.ts`, daemon methods in `src/worktree/connect.ts`,
  auto-delete skips open PRs, desktop "Create PR" button and chip, TUI `/pr`. Decisions 321 to 327.
  Tests: `test/worktree/pr.test.ts`, `test/e2e/create-pr.test.ts`, `test/tui/pr-ui.test.ts` (fake gh and fake API only).

## Done in the Windows walkthrough (Nov 1 2026)
The desktop app, the TUI and the CLI were run by hand on Windows with fake model and gh servers. Fixes: daemon socket
path length (328), daemon start error text (329), sidebar refresh at turn end (330), Enter in the Windows terminal (331),
Windows test fixtures (332), the re-shown prompt test race (333), Electron tests on Windows (334).

## Done on Nov 2 2026
- Landing page in `website/` (decision 339), checked at desktop, tablet and phone widths in light and dark mode.
- Non-code changes start no CI run (decision 340): `ci.yml` and `platforms.yml` skip docs, spec and website changes.
  `.github/workflows/pages.yml` publishes it. GitHub Pages is on (owner approved, Nov 2 2026, source: GitHub Actions).
  The site goes live at https://scottconverse.github.io/rigwell/ after the branch is merged to `main`.
- The root README is now a short entry point that links to the site.

## Next task
None assigned. Ask the owner. The spec is built; later phases (hosted parts, Workstreams) need the owner's go-ahead.

## Open issues
1. Fixed (decision 338): the `test/desktop/electron-final.test.ts` Promote flake (the sidebar row did not show in 20 s).
   The side chat title held the late "About this" text, so the test waited for the wrong title. The failure-details
   print stays in the test.
   Fixed (decision 335): the writes switch step before Promote ("Clicking the checkbox did not change its state",
   ci push run 41403866649). The "Archive Project" failure in that run probably came from it: the side chat stopped
   before Promote, so its file was not archived (likely, not proven). The Promote sidebar step is fixed too (decision 338).
   Fixed (decision 336): the file save flake in `test/desktop/electron.test.ts`. The test's loose "Saved" match also
   matched the editor's button row ("SaveDiscard"), so it did not wait for the save. The app code was correct.
   Another flake: `test/tui/gaps.test.ts` afterAll failed on Windows CI with EBUSY when it deleted its temp folder
   (platforms pull_request run 41403041082, commit a002f25; the push run of the same commit passed). Not reproduced,
   root cause not found. The file opens no watcher or database; the /statusline test runs a shell with cwd in that folder.
2. On a Windows PC without the symlink right, tests that create symlinks fail with `EPERM` (decision 319). CI has the right.
3. Found in the Windows walkthrough, not fixed (outside the agreed scope, owner to decide):
   - "Create PR" on a worktree with only uncommitted edits makes a PR from the "init" commit with no change in it.
   - The cookie import dialog on Windows says only after the click that import is not supported (decision 294).
   - `rigwell sessions search` shows sessions made by `exec` with the title "New Session".
   - `rigwell exec` prints no line break before a "[tool]" line.

## Waiting on the owner (do not decide for them)
- (Resolved) `create_pr` and PR status (§18.6): approved and built (decisions 321 to 327).
- License: decided by the owner: AGPL-3.0-only (`LICENSE`, package.json `license`, README, NOTICE).
- Merge to `main`: the site at https://scottconverse.github.io/rigwell/ goes live only after that merge (Pages is on).
- Declined by the owner: GitHub-event and Slack-message triggers. Spec later phases (not built): hosted parts, §15.10 Workstreams. MCP OAuth sign-in is built (decision 346, `rigwell mcp login <name>`), tested only against a local fake server.

## Not verified on real hardware
macOS and Linux are not release targets (decision 341). Not verified: Windows beyond CI and the Nov 1 walkthrough, real OS keychains, real clipboards and terminals, signed and notarized installers, and the
electron-updater install path.

## Working rules used so far
`docs/handoff/agent-brief.md` holds the rules every build agent followed: no Factory or Droid names, no copying text from
`evidence/`, no em-dash characters (U+2014), tests in temp dirs, fake model servers only, decisions logged, and the
commit trailer. The CI `test` job allows unprivileged user namespaces for the bubblewrap tests; the owner approved this.

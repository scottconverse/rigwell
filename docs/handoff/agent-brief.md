# Rigwell build brief

Rigwell is a local coding workbench built from `spec/harness-spec.md` and
`spec/prompts.md`. Current Windows release: **0.4.1**; Linux/macOS distributions
remain **0.4.0**. The implementation includes the desktop/TUI/SDK, direct and
native-client execution, persistent Workstreams, Missions and the local
features recorded in `PARITY.md`. Qualification limits are separate from
implementation and publication. Read `HANDOFF.md` for current receipts and
`docs/decisions.md` for design history.

## Working checkout and authority

Use branch `phase-1-core-loop`. Inspect the existing checkout and preserve
unrelated edits. Commit/push only that branch; never push to main or merge
without a new explicit owner exception. Do not reset an existing worktree to
establish a starting point. Published tags and release assets are immutable.
The owner granted a one-time closeout merge exception on 2026-11-16. Preserve
the current released tree and both unrelated branch histories; see HANDOFF.md
and decision 525. Further implementation and interactive testing are paused.
The owner's current instructions and bounded completion contract take
precedence over historical process guidance. This brief does not authorize
new features, real model calls, desktop takeover or delegation.

## Code map

- `src/agent/`, `src/protocol/`, `src/daemon/`, `src/sdk/`, `src/tui/`: Session loop, transport and clients.
- `src/adapters/`: direct providers, native clients and request-scoped coordination/permission bridge.
- `src/workstreams/`, `src/worktree/`, `src/missions/`: persistent coordination, Git isolation/PRs and staged work. Check actual paths before editing.
- `src/tools/`, `src/script/`, `src/jobs/`, `src/permissions/`: tools, execution and permission enforcement.
- `src/storage/`, `src/config/`, `src/storage/policy.ts`: profiles, settings, transcripts, credentials and policy.
- `src/mcp/`, `src/plugins/`, `src/skills/`, `src/hooks/`: extensions and integrations.
- `src/automations/`, `src/machines/`, `src/sync/`, `src/eval/`: repeatable/remote work and evaluation.
- `desktop/main/`, `desktop/preload/`, `desktop/renderer/`: native shell, IPC boundary and React UI.
- `test/fakes/`, `test/e2e/`, `test/desktop/`: isolated fake services, protocol and desktop acceptance.
- `docs/user-manual.md`, `docs/workstreams.md`, `docs/auth.md`: user-facing behavior and execution limits.
- `website/`: landing page and generated documentation; package version drives Windows links.

## Work and verification

1. Complete the current authorized outcome. `PARITY.md` is implementation and
   acceptance history, not permission to restart the build or promote optional
   future items into blockers. Hosted Stax stays on the next-version list;
   the DevHarmonics integration proposal is withdrawn.
2. Inspect source and reproduce defects when practical. Make the smallest
   sufficient changes, log material choices in `docs/decisions.md`, and update
   `HANDOFF.md` before stopping. Preserve passed evidence for unchanged inputs.
3. Ordinary tests/CI use fake services, temporary repositories and isolated
   `RIGWELL_HOME`. Personal credentials, instructions and transcripts must not
   enter fixtures. Real quality runs require owner authorization and private
   runtime configuration; never run them in CI. Bedrock remains optional and
   has no owner-account live test.
4. Windows Halo: Bun 1.4.4, Node 22, Git and ripgrep. Use headless checks while
   the owner uses the machine or occupancy is unknown. No visible app/browser,
   installer window or unrelated package installation without authorization.
5. Run meaningful affected checks and required CI. Root typecheck:
   `bunx tsc --noEmit -p .`; desktop: `cd desktop` then `npx tsc -p .`.
   The suite is `bun test`; native Electron checks belong on CI or an explicitly
   approved interactive test. Never skip a test to get green or raise a timeout
   instead of diagnosing its cause.
6. Never copy text/code from `evidence/`. Use it only to check facts. Do not add
   actual model identifiers, credentials or private transcripts to Git. Do not
   write the U+2014 character. Provider/client names are distinct from private
   model identifiers.
7. Public Windows delivery requires the established Azure sign-only workflow,
   final-byte hashes/feed/blockmap, independent signature/publisher/timestamp
   verification, proportionate installed acceptance and public readback.
   Preserve settings, credential stores, previous installers and recovery
   evidence. A documentation-only successor does not require rebuilding or
   re-signing an unchanged binary.
8. Report observed source, test, installed and publication outcomes separately.
   Name failures, unverified limits and required owner input. Do not describe a
   documented blocker, prepared test or running job as completed.

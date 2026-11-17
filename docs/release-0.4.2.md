# Rigwell 0.4.2: Workstream handoffs on Windows

Windows x64 is **0.4.2**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.2/rigwell-setup-0.4.2-x64.exe)
- [GitHub release, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.4.2)
- [User manual](user-manual.md) and [installation guide](install.md)

## What changed

- When a signed-in client waits in a Rigwell coordination tool, a Workstream **Next** handoff now includes its full message body with the listener result. Rigwell saves the message once with its original ID. If the client is using only its own tools, it receives the queued handoff after the native invocation returns.
- The Chat Completions adapter keeps reasoning-only replies in the transcript and omits empty assistant entries from subsequent provider requests. Assistant tool calls still replay normally.
- Offline CLI commands load the runtime services they use. Academy lesson listing and practice setup no longer pay the startup cost of the daemon and browser stack.
- The restart regression test publishes complete readiness files so the test can check session recovery and queued handoffs on Windows.

## Verification and limits

A fresh headless Dispatch Lab run on Windows exercised the Workstream proposal, separate persistent member worktrees, the `Next` contract handoffs, Scheduler acknowledgment, approved integration and a final Verifier review. The starter project had four passing and four failing tests. The integrated project passed all 49 tests and all 16 independent checks, including 100 randomized schedules and preservation of protected files and existing outputs. The walkthrough exercised the corrected source and used configured model connections.

The GitHub release records final package checks and signature provenance. Prior signed upgrade, installed approval and reconnect evidence remains in the [0.4.1 release notes](release-0.4.1.md). Real Mac hardware and broad model-family qualification remain separate from this Windows patch.

The Windows update metadata and blockmap describe the final signed installer. The latest release keeps 0.4.0 Linux and macOS update metadata pointing to the existing 0.4.0 assets.

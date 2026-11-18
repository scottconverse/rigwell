# Rigwell 0.4.3 on Windows

Windows x64 moves to **0.4.3**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.3/rigwell-setup-0.4.3-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.4.3)
- [User manual](user-manual.md) and [installation guide](install.md)

## Workstream review recovery

When a direct model reaches its output limit before making a tool call, Rigwell
asks it to take the next concrete action in the same session. If it reaches the
cap again before a tool call, Rigwell marks the turn failed. A Workstream lead
can listen for the failure alongside incoming review messages.

In a headless Dispatch Lab run on Windows, the Verifier reached the cap,
recovered automatically, wrote its tests, and delivered both source review and
final integrated review. The run completed without operator steering or a
runner restart. The integrated project passed 39 tests and 16 independent
checks, including both scheduling policies and preservation of existing output
on bad input.

This patch also keeps full Next-priority Workstream messages eligible for
delivery across signed-in client turn changes, distinguishes submission from
transcript storage, preserves rejected budget edits, and restores ordinary
keyboard traversal from the desktop composer. The Windows restart regression
now waits for a single child readiness message while retaining its recovery
assertions and overall deadline.

See the release assets for the package checks and signature provenance.
The [0.4.2 release notes](release-0.4.2.md) describe the preceding Windows patch.

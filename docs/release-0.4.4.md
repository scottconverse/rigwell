# Rigwell 0.4.4 on Windows

Windows x64 moves to **0.4.4**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.4/rigwell-setup-0.4.4-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.4.4)
- [User manual](user-manual.md) and [installation guide](install.md)

## Workstream file assignments

When a proposal lists exact write files for each member, Rigwell shows those
assignments during approval and enforces them in the members' local Git
worktrees. The desktop roster shows each member's assignment and its latest
denied write. Scoped members use direct model adapters and file tools. A
signed-in native client can lead the Workstream and run its tests.

The headless Windows source run completed Dispatch Lab with the busy Next
handoff, member review and approved integration. The integrated lab passed 42
project tests and 16 independent checks. All three members stayed within their
approved file assignments.

## Windows remote reconnect

Windows remote bootstrap transfers the build with OpenSSH SFTP, verifies the
archive and installed manifest, and starts an owner-only daemon that survives
the launch connection closing. Reconnecting can reload the same session,
transcript and persistent worktree.

The affected Windows suite passed 114 tests with zero failures or skips. The
release assets record the exact packaged build's installation and signature
evidence. The [0.4.3 release notes](release-0.4.3.md) describe the preceding patch.

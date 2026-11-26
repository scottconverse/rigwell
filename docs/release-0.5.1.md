# Rigwell 0.5.1 on Windows

Windows x64 moves to **0.5.1**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.5.1/rigwell-setup-0.5.1-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.5.1)
- [User manual](user-manual.md) and [installation guide](install.md)

## Workstreams

- A member with approved write files no longer starts on a signed-in client model. The signed-in client cannot keep a member to its approved files.
- Rigwell uses a direct model for that member instead. It picks `workstreams.defaultMemberModel` from your settings when that is a direct model, and otherwise the first direct model in your model list. The lead is told which model the member uses.
- When no direct model is set up, Rigwell refuses to start the member and says why. No member or worktree is left behind.
- A member turn that fails before it writes any text now shows the error on the member card. Before, the card was empty.

## Known limits

- The model swap is covered by tests and CI. It has not been checked in the packaged app.
- The automatic pick takes the first direct model in your model list. Set `workstreams.defaultMemberModel` to choose the model.
- The known limits in the [0.5.0 release notes](release-0.5.0.md) still apply.

The [0.5.0 release notes](release-0.5.0.md) describe the preceding release.

# Rigwell 0.4.5 on Windows

Windows x64 moves to **0.4.5**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.5/rigwell-setup-0.4.5-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.4.5)
- [User manual](user-manual.md) and [installation guide](install.md)

## Desktop

- Tool activity folds into one line and shows the live step.
- The last message stays pinned, and time dividers separate the conversation.
- Messages that wait during a turn are visible.
- Navigation is simpler, with a More menu, Back and Forward, and Settings search.
- The Agents tab and sidebar show live agent status.
- The title bar shows an Update button when a newer version is available.
- The Usage page shows spend bars and provider limits.

## Missions

- A Mission can run up to 4 workers at once. Each worker has its own Git worktree.
- A Mission started from Home enters Mission mode before its first message is sent. If you cancel, the message returns to the composer.
- A spend block ends the turn. The session no longer shows Working.
- Finished worker folders and branches are removed. Rigwell keeps uncommitted or unmerged work.
- A Mission does not complete while a handoff has an unaddressed problem.
- Planning sends fewer repeated files and handoffs to the model.

## Known limits

- **Mission token use can still be high.** In the last three real test runs, the same two-file Mission used 234,951, 461,650 and 1,711,115 tokens. The highest run came from repeated retries of a rejected worker handoff. Set a spend limit before you run a Mission on a paid model.
- A React update-depth error appeared once during Mission planning in an earlier test. It did not recur in later development-build runs. Its cause is not known.

The release assets record the exact packaged build's installation and signature evidence. The [0.4.4 release notes](release-0.4.4.md) describe the preceding patch.

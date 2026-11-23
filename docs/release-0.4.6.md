# Rigwell 0.4.6 on Windows

Windows x64 moves to **0.4.6**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.6/rigwell-setup-0.4.6-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.4.6)
- [User manual](user-manual.md) and [installation guide](install.md)

## Missions

A worker that sends its finished-work report as JSON text is now accepted. Before, Rigwell rejected the text, the model retried, and the Mission could use many more tokens. Text that is not valid JSON, or not an object, is still refused with an example.

## Known limits

- **Mission token use can still vary.** The 0.4.5 test runs used 234,951, 461,650 and 1,711,115 tokens for the same two-file Mission. The highest run came from the rejected handoff that 0.4.6 now accepts. Token use after this change has not been measured in a real-model run. Set a spend limit before you run a Mission on a paid model.
- A React update-depth error appeared once during Mission planning in an earlier test. It did not recur in later runs. Its cause is not known.

The [0.4.5 release notes](release-0.4.5.md) describe the preceding release.

# Branch and PR review

Open Review in the desktop sidebar, or choose Review changes from a session menu. Select a repository/worktree folder and load Branch (optional base revision) or Open PR (optional number; blank selects this branch). Branch review includes staged, unstaged and untracked files against the merge base without changing the checkout.

Choose a file in the directory tree, then Inline, Side by side or Semantic. Shiki highlights source lines. Full files exposes all before/after lines, including lines outside patch hunks. Binary contents are unavailable. Semantic review uses packaged tree-sitter grammars to identify added, removed, changed, moved and renamed functions/classes. Unsupported languages and syntax errors produce warnings. Ambiguous symbol matches remain separate. Snapshot limit: 16 MiB; semantic parsing limit: 2 MiB per file.

Comment on an old or new line and add it to the draft. Send comments to agent starts a normal session in that checkout with an address-these-comments task. It does not post to a code host. PR mode shows existing comments, review summaries and checks. Post comments, Approve and Request changes show the complete payload for confirmation before writing. Cancellation writes nothing. A changed head or closed PR requires reloading and confirming again. Out-of-hunk comments post as path/line references because provider inline APIs require a diff position. A partially failed GitLab multi-request review reports what was already posted; check the PR before retrying.

The daemon uses connected GitHub/GitLab credentials (Settings > Code providers), or existing gh/glab authentication. No credentials are sent to the renderer. Loading and drafting are read-only. See [code-provider authentication](auth.md).

In the TUI, use `/review`, `/review <base>`, `/review pr` or `/review pr <number>` for file/check/comment summaries and semantic changes as text.

The normal protocol exposes `rigwell.review_snapshot {cwd?, base?, pr?: boolean | number}`, returning a connection-owned snapshot; `rigwell.review_task {snapshotId, comments}` prepares an agent task; `rigwell.review_submit {snapshotId, event, body?, comments?}` posts only after permission. Events are COMMENT, APPROVE and REQUEST_CHANGES. Comments have path, side (old/new), positive line and body. Up to 100 comments are accepted. Keep the same connection for a snapshot and its actions; only four snapshots are retained. Headless connections without a permission handler refuse submissions. A submission attempt consumes the snapshot after approval, so reload before retrying a failed write.

Tests use local bare Git remotes, loopback provider/agent servers and fake CLIs. Browser acceptance is headless. Native desktop acceptance and packaged runtime checks run in CI.

---
name: overlap-check
description: Detect branches, worktrees or in-flight changes that touch the same files or areas, so parallel work can be coordinated before it conflicts.
---
# Detect overlapping workstreams

Use this when several branches, worktrees or agents are working in the same repository and the user wants to know where they will collide.

## Steps

1. **Inventory the streams.**
   - `git worktree list` for checked-out worktrees.
   - `git branch -a --sort=-committerdate` and `git for-each-ref` for recent branches; focus on the ones with unmerged commits.
   - Open pull requests, if the user has a tool for them.
   - Choose the base branch (usually the default branch) and note it.
2. **Collect each stream's footprint.** For each branch run `git diff --name-only <base>...<branch>` and include uncommitted work in a worktree with `git -C <path> status --porcelain`. Record the set of files, and the directories they sit in.
3. **Compare.** Build a table of streams against files. A hard overlap is the same file changed in two streams. A soft overlap is the same directory or module, or a change in one stream to a file that another stream imports. Use search to find importers when you need to check.
4. **Test the conflicts that matter.** For hard overlaps, try `git merge-tree --write-tree <a> <b>` (or a throwaway merge in a temporary worktree) to see whether they textually conflict. Never run a real merge in someone's active worktree.
5. **Report.**
   - Pairs of streams with the overlapping files, hard before soft.
   - Whether each pair conflicts textually, and whether it is likely to conflict semantically (for example both change the same function contract).
   - A suggested order of merging, and who should rebase onto whom.
   - Streams with no overlap, so the user knows they are safe to run in parallel.

Do not modify branches, push or delete anything unless the user asks.

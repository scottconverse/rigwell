---
name: review
description: Review a code change (working tree, branch or pull request) for correctness bugs, risky edge cases and missing tests, and report findings by severity.
---
# Code review

Review the change the user points at. If they gave no target, review the uncommitted diff, or the current branch against its base.

## Gather the change

1. Find the diff: `git diff`, `git diff --staged`, or `git diff <base>...HEAD`. For a pull request, use the user's tooling to fetch its diff.
2. Read the full text of each changed file around the hunks. A diff alone hides how callers use the code.
3. Read the tests that exist for the touched code, and the callers of any changed function signature or behavior.

## What to look for

Work in this order and stop to verify anything you are unsure of by reading code or running a command.

1. **Correctness**: wrong conditions, off-by-one errors, unhandled null or empty input, wrong error paths, broken async ordering, resource leaks, changed behavior that callers depend on.
2. **Data and security**: input that reaches a shell, query, path or template unescaped; secrets in code or logs; missing permission checks.
3. **Compatibility**: public API, config or file format changes without migration.
4. **Tests**: new behavior without a test, tests that cannot fail, tests that depend on timing or global state.
5. **Maintainability**: only when it will cause real trouble. Skip style nits that a formatter handles.

## Report

- Lead with a one-line verdict: ready, ready with minor fixes, or needs changes.
- List findings as `severity file:line - problem - suggested fix`, ordered high to low. Use high for bugs and security, medium for likely problems, low for polish.
- Only report issues you can explain concretely. If you are not sure, say what you checked and what remains uncertain.
- Mention what looked good in a sentence if it is useful context.
- Do not edit files unless the user asks you to apply the fixes.

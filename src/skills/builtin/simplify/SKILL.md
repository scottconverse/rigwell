---
name: simplify
description: Clean up recently changed code for reuse, clarity and efficiency without changing behavior, then verify with the tests.
---
# Simplify recent changes

Improve the code that was just written or changed, keeping behavior identical. This is not a bug hunt; if you find a bug, report it and fix it separately.

## Steps

1. Identify the scope: the uncommitted diff, or the commits the user names. Do not wander into unrelated files.
2. Read each changed region and its surroundings. Note the helpers, types and patterns the codebase already has.
3. Look for these, in order of value:
   - **Reuse**: new code that repeats an existing utility, constant or type. Replace it with the existing one.
   - **Duplication inside the change**: near-identical blocks that can share a function. Extract only when there are at least two real uses.
   - **Needless complexity**: deep nesting that early returns would flatten, flags that always have the same value, wrappers that only forward calls, comments that restate code.
   - **Efficiency**: repeated work in a loop, reading a file many times, sequential awaits that could run together, building large arrays only to scan them once.
   - **Dead code**: unused variables, imports, parameters and branches that cannot run.
4. Make the smallest edits that achieve each improvement. Do not rename public APIs, reformat untouched code or add abstractions for hypothetical needs.
5. Run the relevant tests, the typechecker and the linter. If something fails because of your edit, revert that edit rather than patching around it.

## Finish

Summarize what you changed and why in a short list, and mention anything you noticed but deliberately left alone (including suspected bugs).

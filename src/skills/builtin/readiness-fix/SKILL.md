---
name: readiness-fix
description: Diagnose a local mission readiness report and make approved repository fixes through ordinary tools.
---
# Fix mission readiness

Read the saved local report with `rigwell readiness-report --cwd <folder>` or the session's mission_readiness_report method. Check its repository, commit, timestamp and individual statuses before drawing conclusions. A missing command or tool is not proof that the project is broken, and an old passing report does not prove current changes pass.

Trace each failed check in the repository's instructions, manifests and CI. Explain the smallest sufficient fix and stay within the user's authorized task. Use ordinary file and command tools, their permission gates, required hooks and existing policies. Ask before installing dependencies or making unrelated changes. Never rewrite the report's score or acknowledgement file to hide a failure, disable a test, increase a deadline merely to pass, or claim an unrun check succeeded.

After a relevant fix, use ReadinessReport with the actual build and test commands and required executable names. It requests explicit approval again before running repository code. Preserve unknowns, cancellation and omitted checks in the report. Summarize verified results and anything still failing. Mission readiness is advisory: let the user choose whether to continue rather than inventing a release gate or starting mission workers yourself.

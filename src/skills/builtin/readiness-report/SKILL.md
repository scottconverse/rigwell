---
name: readiness-report
description: Check local build, tests and required tools before a mission, preserving unknowns and user approval.
---
# Local mission readiness

Read the repository's instructions, manifest and CI to identify actual build/test commands and executable requirements. Show the commands and explain that they execute repository code in Execute's normal shell. Do not infer success from installed tools or an old report. Do not put credentials in command strings.

Use ReadinessReport with explicit buildCommand, testCommand, tools and an appropriate bounded timeoutMs. It always requests user approval, including at high autonomy. A headless session without an approver refuses; a human can instead run `rigwell readiness-report --cwd <folder> --build <command> --test <command> --tool <executable> --run`. Without --run the CLI only reads the saved report.

Missing commands are not checked; failed, cancelled and timed-out commands do not pass. Summarize statuses and omissions. Raw command output is not retained in the report, so diagnose failures using ordinary approved tools. Do not silently install dependencies, change files or retry a failing command. Propose any needed fixes within the user's task and normal permissions, then rerun the approved checks after changes.

The local report is point-in-time evidence, not a sandbox, test-completeness guarantee or release acceptance. Mission readiness remains a warning; the user can continue and acknowledge the folder. Never change acknowledgement files to hide a failed check or claim a different repository or commit passed.

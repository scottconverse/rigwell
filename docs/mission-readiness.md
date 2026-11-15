# Local mission readiness

Readiness is a warning before mission work, with an explicit Continue anyway path and the existing per-folder acknowledgement. It is not a release gate. The mission-start approval includes readiness for the mission's actual working directory, including when it differs from the session folder.

Generate evidence with explicit commands, not automatic execution of repository settings:

```text
rigwell readiness-report --cwd <repository> --build "<build command>" --test "<test command>" --tool <executable> --run
```

Without `--run`, this command only reads the saved report. `--run` authorizes those commands to execute repository code at the Git repository root, or the given folder if it is not a Git worktree. Commands use Execute's normal platform shell, bounded output handling, timeout and process-tree cancellation. Default timeout is 120 seconds per command; explicit values are bounded to 1..600000 milliseconds. No model, cloud readiness lookup, dependency installation or code repair runs automatically. Do not embed secrets in commands.

In daemon sessions, the `ReadinessReport` tool always asks permission for the exact root and plan, including at high autonomy. No approver means refusal. Cancelling approval starts no commands and writes nothing. Interrupting an active command uses the normal command runner's cancellation; later commands remain not checked. The bundled `/readiness-report` and `/readiness-fix` skills identify commands and diagnose failures through ordinary approved tools, without hiding tests or changing acknowledgement to make a report pass. Standalone sessions without that tool can show the CLI command for the user to run explicitly.

Reports live at `.rigwell/readiness-report.json`. Build and tests must each run successfully and all required executables must exist for level 4. Missing commands stay `not_checked`; failed commands, timeouts and missing tools produce level 2. Git and the actual command shell are always checked; additional executable names are explicit. Executable presence does not prove credentials or service availability. No raw stdout/stderr is retained. Command text uses the existing secret-pattern redactor; avoid secret literals because pattern coverage is not exhaustive. Repository URL identity uses a digest, with a redacted display URL.

Writes are atomic, bounded, and refuse linked/nonregular report paths before execution and again before saving. A generated report from a different origin or commit does not satisfy the score lookup. It is point-in-time evidence, not a claim that uncommitted edits, future changes, test completeness or installed behavior pass. Reports are ordinary editable local files, not signed attestations. Legacy score reports remain compatible. The specified reader-error behavior and folder acknowledgement remain; neither creates a passing evidence report.

The desktop mission warning reads saved checks and tool statuses. Prepare readiness checks appends an unsent request to the main composer, preserving an existing draft. It does not send, run a model, execute commands, change the selected mode or acknowledge the folder. Refresh only reads local state. Continue anyway retains the existing explicit warning override.

Acceptance covers actual Windows commands, CLI read-only versus explicit execution, failures, timeout, cancellation during approval, tool absence, commit binding, link refusal and a headless production session warning connected to the real local daemon. CI uses fake providers only. No real model, visible local app or clean-machine installation is part of this evidence.

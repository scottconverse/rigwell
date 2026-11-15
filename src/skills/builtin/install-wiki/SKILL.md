---
name: install-wiki
description: Set up an approved project automation that refreshes the local wiki after source commits.
---

Confirm the repository folder and explain the proposed schedule before using CreateAutomation. Use scope "project", a clear name such as "Update project wiki", schedule "every 5m", workingDirectory set to that repository, and autonomy "high". Creation goes through Rigwell's actual approval and does not immediately execute a run. The daemon must be running for scheduled work to occur. Never install a Git hook or change the user's global Git configuration.

Set the instructions to load the wiki skill, then execute `rigwell wiki update --after-commit --cwd <folder>` with correct shell quoting. The command compares the current HEAD to the last wiki source commit. If unchanged, report that there was no new commit and do no generation. If changed, refresh the local managed pages and report changed pages and coverage warnings. This polling schedule catches commits while the daemon is running; it is not an instantaneous webhook and performs no network request.

Do not push, publish, commit generated output or post results to an external service. Preserve the selected run profile and ordinary tool permissions. Use ListAutomations and ReadAutomation to inspect an existing installation before adding another. Explain how the user can pause, edit or delete the automation from the Automations page. Build the first wiki separately if the user also requests an initial copy.
